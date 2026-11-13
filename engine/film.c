// SPDX-License-Identifier: GPL-3.0-or-later
/*
    This file is part of Immage, built on darktable,
    Copyright (C) 2026 the Immage authors.

    Immage is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    Immage is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with Immage.  If not, see <http://www.gnu.org/licenses/>.
*/

// film simulation: the stock list and the stock fetch, with the name hashing and ordering they share

#include "engine.h"

// ------------------------------------------------------- film simulation

// spektrafilm's identity for a stock (spektrafilm.c, _name_hash()): params
// name the film and the paper by this hash of the stock's name, so the
// panel's lists must hash exactly as the module does
static uint32_t _sf_name_hash(const char *s)
{
  const dt_hash_t h = dt_hash(DT_INITHASH, s, strlen(s));
  const uint32_t h32 = (uint32_t)(h ^ (h >> 32));
  return h32 ? h32 : 1;
}

// the module's display names, trimmed as its combobox has them
// (spektrafilm.c, _shorten_name())
static void _sf_shorten(char *s)
{
  static const char *const filler[] = { " Professional", " Negative Film", " Reversal Film" };
  for(size_t f = 0; f < G_N_ELEMENTS(filler); f++)
  {
    char *at = strstr(s, filler[f]);
    if(!at) continue;
    const size_t flen = strlen(filler[f]);
    memmove(at, at + flen, strlen(at + flen) + 1);
  }
}

// natural order, numbers by value, as the module sorts its lists
// (spektrafilm.c, _nat_cmp())
static int _sf_nat_cmp(const char *a, const char *b)
{
  for(;;)
  {
    if(*a == 0) return *b == 0 ? 0 : -1;
    if(*b == 0) return 1;
    const int da = (unsigned)*a - '0' < 10u, db = (unsigned)*b - '0' < 10u;
    if(da && db)
    {
      unsigned long va = 0, vb = 0;
      while((unsigned)*a - '0' < 10u) { va = va * 10 + (*a - '0'); a++; }
      while((unsigned)*b - '0' < 10u) { vb = vb * 10 + (*b - '0'); b++; }
      if(va != vb) return va < vb ? -1 : 1;
    }
    else if(da != db)
      return da ? -1 : 1;
    else
    {
      const int ca = g_ascii_tolower(*a), cb = g_ascii_tolower(*b);
      if(ca != cb) return ca < cb ? -1 : 1;
      a++;
      b++;
    }
  }
}

typedef struct _sf_stock_t
{
  char stock[128], name[128], target_print[128];
  gboolean printing, positive, bw;
  double dev_times[SF_MAX_DEV_TIMES];
  int n_dev;
  uint32_t hash;
} _sf_stock_t;

static gint _sf_stock_cmp(gconstpointer a, gconstpointer b)
{
  return _sf_nat_cmp(((const _sf_stock_t *)a)->name, ((const _sf_stock_t *)b)->name);
}

// a download that finished since the last look: the module loads the new
// pack at its next process(), but the pipes' caches still hold renders
// made without it, under the same hashes
static guint _sf_gen_seen = 0;
static void _sf_follow_pack(void)
{
  const guint gen = sf_fetch_generation();
  if(gen == _sf_gen_seen) return;
  _sf_gen_seen = gen;
  if(!_s.open) return;
  const dt_iop_module_t *m = dt_iop_get_module_by_op_priority(_s.dev.iop, "spektrafilm", 0);
  if(!m) return;
  masks_invalidate_from(m->iop_order, "spektrafilm pack ");
  session_changed(DT_DEV_PIPE_SYNCH);
}

// the installed spektrafilm data pack, the one a new edit renders with, and
// its films and papers, read as the module reads them (spektrafilm.c,
// _scan_profiles()): { pack: { dir, lut_id, lut_hash, hand_installed } or
// null, stocks: [{ hash, stock, name, printing, positive, bw,
// target_print, dev_times }] in the module's order }
void film_spektra_stocks(JsonBuilder *b)
{
  _sf_follow_pack();
  char dir[1024];
  gboolean exact = FALSE;
  const gboolean found = sf_fetch_resolve_pack_dir(0, dir, sizeof dir, &exact);
  json_builder_set_member_name(b, "pack");
  GList *list = NULL;
  if(!found)
    json_builder_add_null_value(b);
  else
  {
    json_builder_begin_object(b);
    engine_add_string(b, "dir", dir);
    GPtrArray *packs = sf_fetch_list_packs();
    for(guint k = 0; k < packs->len; k++)
    {
      const sf_fetch_pack_t *fp = g_ptr_array_index(packs, k);
      if(g_strcmp0(fp->dir, dir)) continue;
      engine_add_string(b, "lut_id", fp->lut_id);
      json_builder_set_member_name(b, "lut_hash");
      json_builder_add_int_value(b, fp->lut_hash);
      json_builder_set_member_name(b, "hand_installed");
      json_builder_add_boolean_value(b, fp->hand_installed);
      break;
    }
    g_ptr_array_unref(packs);
    json_builder_end_object(b);

    gchar *profdir = g_build_filename(dir, "profiles", NULL);
    GDir *gd = g_dir_open(profdir, 0, NULL);
    const char *fn;
    while(gd && (fn = g_dir_read_name(gd)))
    {
      if(!g_str_has_suffix(fn, ".json")) continue;
      gchar *path = g_build_filename(profdir, fn, NULL);
      char *perr = NULL;
      sf_profile_t *prof = sf_profile_load(path, 0.5f, &perr);
      g_free(path);
      if(!prof)
      {
        free(perr);
        continue;
      }
      _sf_stock_t *e = g_malloc0(sizeof(_sf_stock_t));
      g_strlcpy(e->stock, sf_profile_stock(prof) ? sf_profile_stock(prof) : fn, sizeof e->stock);
      char *dot = strstr(e->stock, ".json");
      if(dot) *dot = 0;
      g_strlcpy(e->name, sf_profile_name(prof) ? sf_profile_name(prof) : e->stock, sizeof e->name);
      _sf_shorten(e->name);
      e->printing = !g_strcmp0(sf_profile_stage(prof), "printing");
      e->positive = !g_strcmp0(sf_profile_type(prof), "positive");
      e->bw = !g_strcmp0(sf_profile_channel_model(prof), "bw");
      if(sf_profile_target_print(prof)) g_strlcpy(e->target_print, sf_profile_target_print(prof), sizeof e->target_print);
      e->n_dev = sf_profile_dev_times(prof, e->dev_times, SF_MAX_DEV_TIMES);
      e->hash = _sf_name_hash(e->stock);
      sf_profile_free(prof);
      list = g_list_prepend(list, e);
    }
    if(gd) g_dir_close(gd);
    g_free(profdir);
    list = g_list_sort(list, _sf_stock_cmp);
  }
  json_builder_set_member_name(b, "stocks");
  json_builder_begin_array(b);
  for(GList *l = list; l; l = g_list_next(l))
  {
    const _sf_stock_t *e = l->data;
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "hash");
    json_builder_add_int_value(b, e->hash);
    engine_add_string(b, "stock", e->stock);
    engine_add_string(b, "name", e->name);
    json_builder_set_member_name(b, "printing");
    json_builder_add_boolean_value(b, e->printing);
    json_builder_set_member_name(b, "positive");
    json_builder_add_boolean_value(b, e->positive);
    json_builder_set_member_name(b, "bw");
    json_builder_add_boolean_value(b, e->bw);
    engine_add_string(b, "target_print", e->target_print);
    json_builder_set_member_name(b, "dev_times");
    json_builder_begin_array(b);
    for(int k = 0; k < e->n_dev; k++) json_builder_add_double_value(b, e->dev_times[k]);
    json_builder_end_array(b);
    json_builder_end_object(b);
  }
  json_builder_end_array(b);
  g_list_free_full(list, g_free);
}

// the data pack's download, on spektra_fetch.c's own thread: `action`
// "start" (the repository's default pack), "cancel" or "status". replies
// { state: idle, running, done or failed, message, progress (0..1, or -1
// when unknown), started (for start) }. none of them waits for the network
gboolean film_spektra_fetch(JsonObject *req, JsonBuilder *b, char **err)
{
  const char *action = json_object_get_string_member_with_default(req, "action", "status");
  if(!g_strcmp0(action, "start"))
  {
    json_builder_set_member_name(b, "started");
    json_builder_add_boolean_value(b, sf_fetch_start(0u, 0u));
  }
  else if(!g_strcmp0(action, "cancel"))
    sf_fetch_cancel();
  else if(g_strcmp0(action, "status"))
  {
    *err = g_strdup_printf("unknown spektra_fetch action '%s'", action);
    return FALSE;
  }
  char msg[256] = { 0 };
  double progress = -1.0;
  const sf_fetch_state_t state = sf_fetch_status(msg, sizeof msg, &progress);
  static const char *names[] = { "idle", "running", "done", "failed" };
  engine_add_string(b, "state", state <= SF_FETCH_FAILED ? names[state] : "idle");
  engine_add_string(b, "message", msg);
  json_builder_set_member_name(b, "progress");
  json_builder_add_double_value(b, progress);
  if(state == SF_FETCH_DONE) _sf_follow_pack();
  return TRUE;
}
