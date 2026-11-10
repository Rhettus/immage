// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

#include "common/darktable.h"
#include "common/exif.h"
#include "common/image.h"
#include "imageio/imageio_common.h"
extern "C" {
#include "imageio/imageio_dng.h"
}
#include "imageio/imageio_jpeg.h"
#include "strip.h"
#include <exiv2/exiv2.hpp>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <vector>

static void require(bool ok, const char *message)
{
  if(!ok) throw std::runtime_error(message);
}

static std::vector<uint8_t> jpeg(const int width, const int height)
{
  std::vector<uint8_t> pixels((size_t)width * height * 4), out(pixels.size());
  for(int y = 0; y < height; y++)
    for(int x = 0; x < width; x++)
    {
      auto p = &pixels[((size_t)y * width + x) * 4];
      p[0] = x % 256; p[1] = y % 256; p[2] = (x + y) % 256; p[3] = 255;
    }
  const int size = dt_imageio_jpeg_compress(pixels.data(), out.data(), width, height, 90);
  require(size > 0, "could not encode test JPEG");
  out.resize(size);
  return out;
}

static void put16(std::vector<uint8_t> &data, size_t at, uint16_t value)
{
  data[at] = value; data[at + 1] = value >> 8;
}

static void put32(std::vector<uint8_t> &data, size_t at, uint32_t value)
{
  put16(data, at, value); put16(data, at + 2, value >> 16);
}

static void entry(std::vector<uint8_t> &data, size_t at, uint16_t tag, uint16_t type,
                  uint32_t count, uint32_t value)
{
  put16(data, at, tag); put16(data, at + 2, type);
  put32(data, at + 4, count); put32(data, at + 8, value);
}

static void write(const std::string &path, const std::vector<uint8_t> &data)
{
  std::ofstream out(path, std::ios::binary);
  out.write((const char *)data.data(), data.size());
  require(bool(out), "could not write fixture");
}

static void fixture(const std::string &path, bool late)
{
  const auto large = jpeg(1600, 1000), small = jpeg(400, 300);
  const size_t maker = late ? 20 * 1024 * 1024 : 1024;
  std::vector<uint8_t> data(24 * 1024 * 1024);
  data[0] = data[1] = 'I'; put16(data, 2, 42); put32(data, 4, 8);
  put16(data, 8, 8);
  entry(data, 10, 256, 4, 1, 1600);
  entry(data, 22, 257, 4, 1, 1000);
  entry(data, 34, 259, 3, 1, 6);
  entry(data, 46, 271, 2, 8, maker);
  entry(data, 58, 274, 3, 1, 6);
  entry(data, 70, 513, 4, 1, 2 * 1024 * 1024);
  entry(data, 82, 514, 4, 1, large.size());
  entry(data, 94, 306, 2, 20, 1100);
  put32(data, 106, 512);
  put16(data, 512, 5);
  entry(data, 514, 256, 4, 1, 400);
  entry(data, 526, 257, 4, 1, 300);
  entry(data, 538, 259, 3, 1, 6);
  entry(data, 550, 513, 4, 1, 128 * 1024);
  entry(data, 562, 514, 4, 1, small.size());
  memcpy(data.data() + maker, "Fixture", 8);
  memcpy(data.data() + 1100, "2026:01:02 03:04:05", 20);
  memcpy(data.data() + 2 * 1024 * 1024, large.data(), large.size());
  memcpy(data.data() + 128 * 1024, small.data(), small.size());
  write(path, data);
}

static uint64_t read_chars()
{
#ifdef __linux__
  std::ifstream io("/proc/self/io");
  std::string key; uint64_t value;
  while(io >> key >> value) if(key == "rchar:") return value;
#endif
  return 0;
}

static void check(const std::string &path, bool synthetic)
{
  dt_image_t image;
  dt_image_init(&image);
  uint64_t start = read_chars();
  require(!dt_exif_read(&image, path.c_str()), "metadata read failed");
  const uint64_t metadata_bytes = read_chars() - start;
  if(synthetic)
  {
    require(!strcmp(image.exif_maker, "Fixture"), "metadata prefix lost late maker");
    require(image.orientation == dt_image_orientation_to_flip_bits(6), "orientation changed");
  }
  auto full = Exiv2::ImageFactory::open(path);
  full->readMetadata();
  require(image.width == (int)full->pixelWidth() && image.height == (int)full->pixelHeight(),
          "metadata dimensions changed");
  uint8_t *encoded = nullptr;
  size_t size = 0; char *mime = nullptr;
  start = read_chars();
  require(!dt_exif_get_thumbnail_sized(path.c_str(), &encoded, &size, &mime, 256), "no sized preview");
  const uint64_t preview_bytes = read_chars() - start;
  Exiv2::PreviewManager previews(*full);
  bool identical = false;
  for(const auto &p : previews.getPreviewProperties())
  {
    const auto original = previews.getPreviewImage(p);
    if(original.size() == size && !memcmp(original.pData(), encoded, size)) identical = true;
  }
  require(identical, "JPEG range differs from original embedded preview");
  free(encoded); free(mime);
  for(const int target : {64, 128, 256, 512})
  {
    uint8_t *pixels = nullptr;
    int32_t width = 0, height = 0;
    dt_colorspaces_color_profile_type_t color;
    require(!dt_imageio_thumbnail(path.c_str(), &pixels, &width, &height, &color, target),
            "scaled preview decode failed");
    require(width > 0 && height > 0 && pixels, "invalid scaled image");
    if(synthetic)
    {
      const int expected = target == 64 ? 100 : target == 128 ? 200 : target == 256 ? 400 : 800;
      require(width == expected, "wrong preview selection or JPEG scale");
      require(color == DT_COLORSPACE_SRGB, "thumbnail color space changed");
    }
    dt_free_align(pixels);
  }
  std::cout << path << ": metadata and preview match; metadata read chars=" << metadata_bytes
            << ", preview read chars=" << preview_bytes << std::endl;
}

static void check_dng_orientation(const std::string &path)
{
  for(int exif = 1; exif <= 8; exif++)
  {
    const auto bits = dt_image_orientation_to_flip_bits(exif);

    // Simulate the DNG writer's TOPLEFT tag independently of the metadata
    // helper, so this check fails if denoise stamping stops preserving source orientation.
    auto reset = Exiv2::ImageFactory::open(path);
    reset->readMetadata();
    reset->exifData()["Exif.Image.Orientation"] = static_cast<uint16_t>(1);
    reset->writeMetadata();
    require(denoised_metadata(path.c_str(), bits), "could not stamp denoise orientation");
    auto image = Exiv2::ImageFactory::open(path);
    image->readMetadata();
    const auto found = image->exifData().findKey(Exiv2::ExifKey("Exif.Image.Orientation"));
    require(found != image->exifData().end() && found->toInt64() == exif,
            "denoised DNG orientation does not match the source");
    const auto marker = image->xmpData().findKey(Exiv2::XmpKey("Xmp.darktable.neural_restore"));
    require(marker != image->xmpData().end() && marker->toString() == "raw-denoise",
            "denoised DNG marker was lost");
    require(image->exifData().findKey(Exiv2::ExifKey("Exif.Image.DNGVersion")) != image->exifData().end(),
            "DNG version was lost while stamping denoise metadata");
    require(image->exifData().findKey(Exiv2::ExifKey("Exif.Image.ColorMatrix1")) != image->exifData().end(),
            "DNG color matrix was lost while stamping denoise metadata");

    dt_image_t decoded;
    dt_image_init(&decoded);
    require(!dt_exif_read(&decoded, path.c_str()), "stamped DNG metadata read failed");
    require(decoded.orientation == bits, "DNG importer did not read the stamped orientation");

    auto hdr_reset = Exiv2::ImageFactory::open(path);
    hdr_reset->readMetadata();
    hdr_reset->exifData()["Exif.Image.Orientation"] = static_cast<uint16_t>(exif == 8 ? 1 : exif + 1);
    hdr_reset->writeMetadata();
    require(dng_orientation_metadata(path.c_str(), bits), "could not stamp HDR orientation");
    auto hdr = Exiv2::ImageFactory::open(path);
    hdr->readMetadata();
    const auto hdr_orientation = hdr->exifData().findKey(Exiv2::ExifKey("Exif.Image.Orientation"));
    require(hdr_orientation != hdr->exifData().end() && hdr_orientation->toInt64() == exif,
            "HDR DNG orientation does not match the source");
  }
  std::cout << path << ": all eight denoise/HDR DNG orientations and metadata preserved" << std::endl;
}

static void dng_fixture(const std::string &path)
{
  dt_image_t meta;
  dt_image_init(&meta);
  meta.buf_dsc.filters = 0x94949494;
  meta.raw_white_point = 65535;
  for(int i = 0; i < 4; i++) meta.wb_coeffs[i] = 1.0f;
  std::strcpy(meta.camera_maker, "Fixture");
  std::strcpy(meta.camera_model, "Orientation Test");
  const uint16_t cfa[16] = { 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15 };
  require(!dt_imageio_dng_write_cfa_bayer(path.c_str(), cfa, 4, 4, &meta, nullptr, 0, nullptr),
          "could not write orientation DNG fixture");
}

int main(int argc, char **argv)
{
  if(argc < 2) return 2;
  const std::string dir = argv[1];
  if(g_mkdir_with_parents(dir.c_str(), 0700)) return 2;
  const std::string config = dir + "/config", cache = dir + "/cache";
  char *args[] = { argv[0], (char *)"--library", (char *)":memory:", (char *)"--configdir",
                   (char *)config.c_str(), (char *)"--cachedir", (char *)cache.c_str(),
                   (char *)"--conf", (char *)"opencl=false" };
  if(dt_init(9, args, FALSE, TRUE, nullptr)) return 3;
  int result = 0;
  try
  {
    for(const bool late : {false, true})
    {
      const auto path = dir + (late ? "/late.tif" : "/bounded.tif");
      fixture(path, late);
      check(path, true);
    }
    const auto dng = dir + "/orientation.dng";
    dng_fixture(dng);
    check_dng_orientation(dng);
    for(int i = 2; i < argc; i++) check(argv[i], false);
    const auto broken = dir + "/truncated.tif";
    write(broken, {'I', 'I', 42, 0, 8, 0, 0, 0, 255, 255});
    for(const auto &path : {broken, dir + "/missing.raw"})
    {
      uint8_t *pixels = nullptr;
      int32_t width = 0, height = 0;
      dt_colorspaces_color_profile_type_t color;
      require(dt_imageio_thumbnail(path.c_str(), &pixels, &width, &height, &color, 256),
              "invalid image accepted");
      dt_free_align(pixels);
    }
  }
  catch(const std::exception &e) { std::cerr << e.what() << std::endl; result = 1; }
  dt_cleanup();
  return result;
}
