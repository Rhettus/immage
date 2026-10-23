// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Linux: a WebKit web extension, loaded into the window's web process
// (main.rs, webext_dir), that hands the page a rendered frame from shared
// memory. returned through Tauri, a frame crosses WebKitGTK's custom URI
// scheme at about 25 ms a megapixel, and slower still while a 2x page draws.
// render writes the frame to /dev/shm instead and replies with its header
// alone (sharedFrames.ts). built by app/scripts/build_appimage.sh
#include <webkit2/webkit-web-extension.h>
#include <fcntl.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#define PREFIX "immage-frame-"
// a frame is the viewer in device pixels, or the 3072 px base; a bound
// well past an 8K screen's
#define MAX_SIZE (256 * 1024 * 1024)

// only render's own files: "immage-frame-", 16 hex digits of the page's
// token, "-", the frame's id. the page names no other file
static gboolean _frame_name(const char *name)
{
  if(strncmp(name, PREFIX, strlen(PREFIX))) return FALSE;
  const char *p = name + strlen(PREFIX);
  for(int k = 0; k < 16; k++, p++)
    if(!g_ascii_isxdigit(*p)) return FALSE;
  if(*p++ != '-' || !g_ascii_isdigit(*p)) return FALSE;
  for(int k = 0; *p; k++, p++)
    if(k == 10 || !g_ascii_isdigit(*p)) return FALSE;
  return TRUE;
}

// immageFrame(name): the frame as a Uint8Array, its file deleted, or null.
// copied once into memory WebKit allocates: it kills the web process if a
// page is handed memory it did not allocate (its gigacage), so the mapped
// file itself cannot be given
static JSCValue *_frame(GPtrArray *args, gpointer user_data)
{
  JSCContext *ctx = jsc_context_get_current();
  if(args->len != 1 || !jsc_value_is_string(args->pdata[0])) return jsc_value_new_null(ctx);
  char *name = jsc_value_to_string(args->pdata[0]);
  JSCValue *out = NULL;
  if(_frame_name(name))
  {
    char *path = g_build_filename("/dev/shm", name, NULL);
    const int fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    struct stat st;
    if(fd >= 0 && !fstat(fd, &st) && S_ISREG(st.st_mode) && st.st_size > 0 && st.st_size <= MAX_SIZE)
    {
      void *p = mmap(NULL, st.st_size, PROT_READ, MAP_SHARED, fd, 0);
      if(p != MAP_FAILED)
      {
        out = jsc_value_new_typed_array(ctx, JSC_TYPED_ARRAY_UINT8, st.st_size);
        gsize len = 0;
        void *data = out ? jsc_value_typed_array_get_data(out, &len) : NULL;
        if(data && len == (gsize)st.st_size)
          memcpy(data, p, len);
        else
          g_clear_object(&out);
        munmap(p, st.st_size);
      }
    }
    if(fd >= 0)
    {
      close(fd);
      unlink(path);
    }
    g_free(path);
  }
  g_free(name);
  return out ? out : jsc_value_new_null(ctx);
}

static void _window_object_cleared(WebKitScriptWorld *world, WebKitWebPage *page, WebKitFrame *frame,
                                   gpointer user_data)
{
  JSCContext *ctx = webkit_frame_get_js_context_for_script_world(frame, world);
  JSCValue *f = jsc_value_new_function_variadic(ctx, "immageFrame", G_CALLBACK(_frame), NULL, NULL,
                                                JSC_TYPE_VALUE);
  jsc_context_set_value(ctx, "immageFrame", f);
  g_object_unref(f);
  g_object_unref(ctx);
}

G_MODULE_EXPORT void webkit_web_extension_initialize(WebKitWebExtension *extension)
{
  g_signal_connect(webkit_script_world_get_default(), "window-object-cleared",
                   G_CALLBACK(_window_object_cleared), NULL);
}
