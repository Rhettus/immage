// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
// Reuse the engine's compilation flags; dead-section linking retains only the
// callback under test, its byte writer and the libjpeg/GLib helpers.
#undef NDEBUG
#define main unused_engine_main
#include "../engine/main.c"
#undef main
#include <assert.h>
static int test_subsample;
int dt_conf_get_int(const char *name)
{
  return !strcmp(name, "metadata/resolution") ? 300 : test_subsample;
}
int main(void)
{
  dt_imageio_module_data_t data = { .width = 31, .height = 19 };
  uint8_t input[31 * 19 * 4];
  for(int y = 0; y < 19; y++) for(int x = 0; x < 31; x++)
  {
    size_t k = (y * 31 + x) * 4;
    input[k] = x * 8; input[k+1] = y * 13; input[k+2] = (x+y)*5; input[k+3] = 255;
  }
  char *path = NULL;
  int fd = g_file_open_tmp("immage-preview-test-XXXXXX", &path, NULL);
  assert(fd >= 0); close(fd);
  for(test_subsample = 0; test_subsample <= 4; test_subsample++)
  {
    assert(!preview_jpeg_write(&data, path, input, DT_COLORSPACE_SRGB, NULL,
                               NULL, 0, 0, 0, 0, NULL, FALSE));
    char *bytes = NULL; gsize length = 0;
    assert(g_file_get_contents(path, &bytes, &length, NULL));
    struct jpeg_decompress_struct decoder = { 0 };
    struct jpeg_error_mgr error;
    decoder.err = jpeg_std_error(&error);
    jpeg_create_decompress(&decoder);
    jpeg_mem_src(&decoder, (unsigned char *)bytes, length);
    assert(jpeg_read_header(&decoder, TRUE) == JPEG_HEADER_OK);
    assert(decoder.image_width == 31 && decoder.image_height == 19);
    int horizontal = test_subsample == 1 || test_subsample == 2 ? 1 : 2;
    int vertical = test_subsample == 1 || test_subsample == 3 ? 1 : 2;
    assert(decoder.comp_info[0].h_samp_factor == horizontal);
    assert(decoder.comp_info[0].v_samp_factor == vertical);
    assert(decoder.X_density == 300 && decoder.Y_density == 300);
    jpeg_start_decompress(&decoder);
    unsigned char row[31 * 3];
    unsigned long absolute_error = 0;
    while(decoder.output_scanline < decoder.output_height)
    {
      size_t y = decoder.output_scanline;
      JSAMPROW rows[] = { row };
      assert(jpeg_read_scanlines(&decoder, rows, 1) == 1);
      for(int x = 0; x < 31; x++) for(int k = 0; k < 3; k++)
        absolute_error += abs((int)row[x*3+k] - input[(y*31+x)*4+k]);
    }
    assert(absolute_error < sizeof(input) * 5);
    jpeg_finish_decompress(&decoder);
    jpeg_destroy_decompress(&decoder);
    g_free(bytes);
  }
  assert(preview_jpeg_write(&data, "/dev/null/missing", input, DT_COLORSPACE_SRGB,
                            NULL, NULL, 0, 0, 0, 0, NULL, FALSE));
  data.width = 0;
  assert(preview_jpeg_write(&data, path, input, DT_COLORSPACE_SRGB,
                            NULL, NULL, 0, 0, 0, 0, NULL, FALSE));
  g_unlink(path); g_free(path);
  return 0;
}
