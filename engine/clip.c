// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// CPU-only CLIP inference on its own serial worker. No editor session access.
#include "engine.h"
#include "clip_contract.h"
#include <sys/stat.h>

static GMutex _clip_lock;
static GThreadPool *_clip_pool = NULL;
static int _clip_pending = 0;
static gboolean _clip_stopped = FALSE;
#ifdef HAVE_AI
static dt_ai_environment_t *_clip_env = NULL;
static dt_ai_context_t *_clip_models[2] = { NULL, NULL };
static char *_clip_root = NULL;
static void _clip_unload(void)
{
  for(int i = 0; i < 2; i++)
    if(_clip_models[i]) { dt_ai_unload_model(_clip_models[i]); _clip_models[i] = NULL; }
  if(_clip_env) { dt_ai_env_destroy(_clip_env); _clip_env = NULL; }
  g_clear_pointer(&_clip_root, g_free);
}
static dt_ai_context_t *_clip_load(const char *root, const gboolean vision, char **err)
{
  g_mutex_lock(&export_ai_load_lock);
  if(g_strcmp0(root, _clip_root)) _clip_unload();
  if(!_clip_env)
  {
    _clip_root = g_strdup(root);
    _clip_env = dt_ai_env_init(root);
    if(_clip_env) dt_ai_env_set_provider(_clip_env, DT_AI_PROVIDER_CPU);
  }
  if(_clip_env && !_clip_models[vision])
    _clip_models[vision] = dt_ai_load_model(_clip_env, "immage-clip",
      vision ? "../onnx/vision_model.onnx" : "../onnx/text_model.onnx", DT_AI_PROVIDER_CPU);
  dt_ai_context_t *ctx = _clip_models[vision];
  g_mutex_unlock(&export_ai_load_lock);
  if(!ctx) *err = g_strdup("CPU CLIP model is unavailable; verify the optional model package");
  return ctx;
}
static gboolean _clip_do(JsonObject *req, JsonBuilder *reply, char **err)
{
  const char *tower = json_object_get_string_member_with_default(req, "tower", "");
  const gboolean vision = !strcmp(tower, "vision");
  const char *root = json_object_get_string_member_with_default(req, "model_root", "");
  const char *path = json_object_get_string_member_with_default(req, "input", "");
  if((strcmp(tower, "text") && !vision) || !g_path_is_absolute(root) || !g_path_is_absolute(path))
  { *err = g_strdup("Invalid CLIP tower or tensor paths"); return FALSE; }
  const size_t expected = vision ? 3*224*224*sizeof(float) : 2*77*sizeof(int64_t);
  FILE *file = g_fopen(path, "rb");
  struct stat st;
  if(!file || fstat(fileno(file), &st) || !S_ISREG(st.st_mode) || st.st_size < 0 || (uint64_t)st.st_size != expected)
  { if(file) fclose(file); *err = g_strdup("Invalid CLIP tensor file size or type"); return FALSE; }
  void *buffer = g_malloc(expected);
  const gboolean read_ok = fread(buffer, 1, expected, file) == expected && fgetc(file) == EOF && !ferror(file);
  fclose(file);
  if(!read_ok) { g_free(buffer); *err = g_strdup("Could not read CLIP tensor"); return FALSE; }
  gboolean valid = TRUE;
  if(vision)
  {
    uint32_t *bits = buffer;
    for(size_t i = 0; i < expected/4; i++)
    {
      bits[i] = GUINT32_FROM_LE(bits[i]);
      float value; memcpy(&value, &bits[i], 4);
      if(!isfinite(value) || fabsf(value) > 16.0f) valid = FALSE;
    }
  }
  else
  {
    int64_t *tokens = buffer;
    for(int i = 0; i < 154; i++) tokens[i] = GINT64_FROM_LE(tokens[i]);
    for(int i = 0; i < 77; i++)
      if(tokens[i] < 0 || tokens[i] > 49407 || (tokens[77+i] != 0 && tokens[77+i] != 1)) valid = FALSE;
    int used = 0;
    while(used < 77 && tokens[77+used] == 1) used++;
    if(used < 2 || tokens[0] != 49406 || tokens[used-1] != 49407) valid = FALSE;
    for(int i = used; i < 77; i++) if(tokens[77+i] != 0 || tokens[i] != 49407) valid = FALSE;
  }
  if(!valid) { g_free(buffer); *err = g_strdup("Invalid CLIP tensor values"); return FALSE; }
  dt_ai_context_t *ctx = _clip_load(root, vision, err);
  if(!ctx) { g_free(buffer); return FALSE; }
  dt_ai_tensor_t inputs[2] = {0}, outputs[3] = {0};
  int64_t input_shapes[2][4] = {{0}}, output_shapes[3][3] = {{0}};
  const int ni = dt_ai_get_input_count(ctx), no = dt_ai_get_output_count(ctx);
  int projection = -1;
  gboolean ok = ni >= 1 && ni <= (vision ? 1 : 2) && no >= 1 && no <= 3;
  gboolean seen_ids = FALSE, seen_mask = FALSE;
  for(int i = 0; ok && i < ni; i++)
  {
    const char *name = dt_ai_get_input_name(ctx, i);
    const dt_ai_dtype_t type = dt_ai_get_input_type(ctx, i);
    if(vision && name && !strcmp(name, "pixel_values") && type == DT_AI_FLOAT)
    {
      input_shapes[i][0] = 1; input_shapes[i][1] = 3; input_shapes[i][2] = input_shapes[i][3] = 224;
      inputs[i] = (dt_ai_tensor_t){ buffer, type, input_shapes[i], 4 };
    }
    else if(!vision && type == DT_AI_INT64 && name
            && ((!strcmp(name, "input_ids") && !seen_ids) || (!strcmp(name, "attention_mask") && !seen_mask)))
    {
      const gboolean mask = !strcmp(name, "attention_mask");
      seen_ids |= !mask; seen_mask |= mask;
      input_shapes[i][0] = 1; input_shapes[i][1] = 77;
      inputs[i] = (dt_ai_tensor_t){ (int64_t *)buffer+(mask ? 77 : 0), type, input_shapes[i], 2 };
    }
    else ok = FALSE;
  }
  if(!vision && !seen_ids) ok = FALSE;
  for(int i = 0; ok && i < no; i++)
  {
    int64_t declared[3] = {0};
    const char *name = dt_ai_get_output_name(ctx, i);
    const int rank = dt_ai_get_output_shape(ctx, i, declared, 3);
    if(dt_ai_get_output_type(ctx, i) != DT_AI_FLOAT || !clip_output_shape(vision, name, rank, declared, output_shapes[i]))
    { ok = FALSE; break; }
    if(!strcmp(name, vision ? "image_embeds" : "text_embeds"))
    { if(projection >= 0) { ok = FALSE; break; } projection = i; }
    const size_t count = dt_ai_tensor_element_count(output_shapes[i], rank);
    outputs[i] = (dt_ai_tensor_t){ g_malloc0(count*sizeof(float)), DT_AI_FLOAT, output_shapes[i], rank };
  }
  if(projection < 0) ok = FALSE;
  if(!ok) *err = g_strdup("Unsupported CLIP graph inputs, outputs, types or shapes");
  else if(dt_ai_run(ctx, inputs, ni, outputs, no) < 0)
  { ok = FALSE; *err = g_strdup("CPU CLIP inference failed"); }
  else if(!clip_normalize(outputs[projection].data))
  { ok = FALSE; *err = g_strdup("CLIP produced an invalid embedding"); }
  if(ok)
  {
    json_builder_set_member_name(reply, "embedding"); json_builder_begin_array(reply);
    const float *embedding = outputs[projection].data;
    for(int i = 0; i < 512; i++) json_builder_add_double_value(reply, embedding[i]);
    json_builder_end_array(reply);
  }
  for(int i = 0; i < 3; i++) g_free(outputs[i].data);
  g_free(buffer);
  return ok;
}
#else
static gboolean _clip_do(JsonObject *req, JsonBuilder *reply, char **err)
{ (void)req; (void)reply; *err = g_strdup("This engine was built without CPU ONNX support"); return FALSE; }
#endif
static void _clip_reply(FILE *out, JsonObject *req, const char *error)
{
  JsonBuilder *b = json_builder_new(); json_builder_begin_object(b);
  json_builder_set_member_name(b, "tag"); json_builder_add_int_value(b, json_object_get_int_member_with_default(req, "tag", 0));
  json_builder_set_member_name(b, "ok"); json_builder_add_boolean_value(b, FALSE);
  json_builder_set_member_name(b, "error"); json_builder_add_string_value(b, error);
  json_builder_end_object(b); engine_reply(out, b); g_object_unref(b);
}
static void _clip_run(gpointer data, gpointer user)
{
  JsonParser *parser = data; JsonObject *req = json_node_get_object(json_parser_get_root(parser));
  JsonBuilder *b = json_builder_new(); char *error = NULL;
  json_builder_begin_object(b);
  json_builder_set_member_name(b, "tag"); json_builder_add_int_value(b, json_object_get_int_member_with_default(req, "tag", 0));
  const gboolean ok = _clip_do(req, b, &error);
  json_builder_set_member_name(b, "ok"); json_builder_add_boolean_value(b, ok);
  if(!ok) { json_builder_set_member_name(b, "error"); json_builder_add_string_value(b, error ? error : "CLIP inference failed"); }
  json_builder_end_object(b); engine_reply(user, b);
  g_free(error); g_object_unref(b); g_object_unref(parser);
  g_mutex_lock(&_clip_lock); _clip_pending--; g_mutex_unlock(&_clip_lock);
}
static FILE *_clip_out = NULL;
void clip_start(FILE *out)
{
  _clip_out = out;
  _clip_stopped = FALSE;
}
// Takes ownership of parser on every path. At most eight requests, including active.
void clip_queue(JsonParser *parser)
{
  JsonObject *req = json_node_get_object(json_parser_get_root(parser));
  g_mutex_lock(&_clip_lock);
  if(_clip_stopped || _clip_pending >= 8)
  { g_mutex_unlock(&_clip_lock); _clip_reply(_clip_out, req, "CLIP worker is full or stopping"); g_object_unref(parser); return; }
  GError *error = NULL;
  if(!_clip_pool) _clip_pool = g_thread_pool_new(_clip_run, _clip_out, 1, TRUE, &error);
  if(!_clip_pool)
  {
    g_mutex_unlock(&_clip_lock);
    _clip_reply(_clip_out, req, error ? error->message : "Could not start CPU CLIP worker");
    g_clear_error(&error); g_object_unref(parser); return;
  }
  _clip_pending++;
  const gboolean pushed = g_thread_pool_push(_clip_pool, parser, &error);
  if(!pushed) _clip_pending--;
  g_mutex_unlock(&_clip_lock);
  if(!pushed)
  { _clip_reply(_clip_out, req, error ? error->message : "CLIP queue failed"); g_clear_error(&error); g_object_unref(parser); }
}
void clip_wait(void)
{
  g_mutex_lock(&_clip_lock); _clip_stopped = TRUE; GThreadPool *pool = _clip_pool; _clip_pool = NULL; g_mutex_unlock(&_clip_lock);
  if(pool) g_thread_pool_free(pool, FALSE, TRUE);
#ifdef HAVE_AI
  g_mutex_lock(&export_ai_load_lock); _clip_unload(); g_mutex_unlock(&export_ai_load_lock);
#endif
}
