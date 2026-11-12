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

// what darktable's export flags cannot leave out of an exported file:
// its EXIF is the source's, less thumbnails and the raw's own layout
// (dt_exif_read_blob(), src/common/exif.cc), so serial numbers in the
// standard tags, the DNG tags, XMP and the makernotes all reach the file,
// and so do a title or keywords another program wrote into the EXIF

#include <cstring>
#include <stdexcept>
#include <string>
#include <map>
#include <glib/gstdio.h>
#include "common/image.h"

// as exif.cc includes it (XCode 15.2)
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wshadow"
#include <exiv2/exiv2.hpp>
#pragma GCC diagnostic pop

#include "common/darktable.h"
#include "strip.h"

// darktable's exiv2 calls hold this lock (exif.cc's Lock): exiv2 is not
// safe to call from two threads, and the engine's prefetch reads raws on
// its own threads
namespace
{
class _lock
{
public:
  _lock() { dt_pthread_mutex_lock(&darktable.exiv2_threadsafe); }
  ~_lock() { dt_pthread_mutex_unlock(&darktable.exiv2_threadsafe); }
};
}

static bool _contains(const std::string &s, const char *needle)
{
  return s.find(needle) != std::string::npos;
}

// a serial number or an owner's name, by tag name: the cameras name them
// SerialNumber, InternalSerialNumber, LensSerialNumber, SerialNO, OwnerName,
// CameraOwnerName, ...
static bool _personal(const std::string &tag)
{
  std::string t(tag);
  for(char &c : t) c = g_ascii_tolower(c);
  return _contains(t, "serial") || _contains(t, "ownername");
}

// Sony keeps its serial number in an enciphered block, 0x9050, that exiv2
// does not decode (ExifTool's Sony Tag9050, InternalSerialNumber at 0x88).
// the rest of it is the camera's own bookkeeping, shutter count included
static bool _personal_exif(const Exiv2::Exifdatum &d)
{
  return _personal(d.tagName()) || (d.tag() == 0x9050 && d.groupName().rfind("Sony", 0) == 0);
}

// the camera, lens and exposure settings: of Exif.Photo, only the dates
// and the image's own layout stay. the GPS tags, in a group of their own,
// are left to darktable's location flag
static bool _camera_exif(const Exiv2::Exifdatum &d)
{
  const std::string group = d.groupName();
  const std::string tag = d.tagName();
  if(Exiv2::ExifTags::isMakerGroup(group) || group == "MakerNote") return true;
  if(group == "Image")
    return tag == "Make" || tag == "Model" || tag == "UniqueCameraModel" || tag == "LocalizedCameraModel"
           || tag == "CameraSerialNumber"
           || tag == "LensInfo" || tag == "ExposureTime" || tag == "FNumber" || tag == "ExposureProgram"
           || tag == "ISOSpeedRatings" || tag == "ExposureBiasValue" || tag == "MeteringMode"
           || tag == "Flash" || tag == "FocalLength";
  if(group == "Photo")
    return !(g_str_has_prefix(tag.c_str(), "DateTime") || g_str_has_prefix(tag.c_str(), "OffsetTime")
             || g_str_has_prefix(tag.c_str(), "SubSecTime") || tag == "ColorSpace" || tag == "Gamma"
             || tag == "PixelXDimension" || tag == "PixelYDimension" || tag == "ExifVersion"
             || tag == "FlashpixVersion" || tag == "ComponentsConfiguration" || tag == "UserComment"
             || tag == "InteroperabilityTag");
  return false;
}

static bool _camera_xmp(const Exiv2::Xmpdatum &d)
{
  const std::string prefix = d.groupName();
  const std::string tag = d.tagName();
  if(prefix == "aux" || prefix == "exifEX") return true;
  if(prefix == "tiff") return tag == "Make" || tag == "Model";
  // Lightroom's record of the camera and lens its profile was made for
  if(prefix == "photoshop") return tag.rfind("CameraProfiles", 0) == 0;
  if(prefix == "exif")
    return !(g_str_has_prefix(tag.c_str(), "DateTime") || g_str_has_prefix(tag.c_str(), "GPS")
             || tag == "ColorSpace" || tag == "PixelXDimension" || tag == "PixelYDimension"
             || tag == "ExifVersion" || tag == "FlashpixVersion" || tag == "ComponentsConfiguration"
             || tag == "UserComment");
  return false;
}

// the source's own text fields, which darktable's DT_META_METADATA does
// not reach: it decides only what darktable writes
static bool _description_exif(const std::string &tag)
{
  return tag == "ImageDescription" || tag == "Artist" || tag == "Copyright" || tag == "XPTitle"
         || tag == "XPComment" || tag == "XPAuthor" || tag == "XPSubject" || tag == "UserComment"
         || tag == "ImageTitle" || tag == "Photographer" || tag == "ImageEditor";
}

static bool _description_xmp(const Exiv2::Xmpdatum &d)
{
  const std::string prefix = d.groupName();
  const std::string tag = d.tagName();
  if(prefix == "dc") return tag == "title" || tag == "description" || tag == "creator" || tag == "rights";
  if(prefix == "xmpRights") return true;
  if(prefix == "photoshop")
    return tag == "Headline" || tag == "Credit" || tag == "Source" || tag == "Instructions"
           || tag == "AuthorsPosition" || tag == "CaptionWriter";
  return prefix == "Iptc4xmpCore" && tag.rfind("CreatorContactInfo", 0) == 0;
}

static bool _keywords_exif(const std::string &tag)
{
  return tag == "XPKeywords";
}

static bool _keywords_xmp(const Exiv2::Xmpdatum &d)
{
  const std::string prefix = d.groupName();
  return (prefix == "dc" && d.tagName() == "subject") || (prefix == "lr" && d.tagName() == "hierarchicalSubject");
}

static bool _exif_out(const Exiv2::Exifdatum &d, const strip_t what)
{
  return ((what & STRIP_SERIALS) && _personal_exif(d)) || ((what & STRIP_CAMERA) && _camera_exif(d))
         || ((what & STRIP_DESCRIPTION) && _description_exif(d.tagName()))
         || ((what & STRIP_KEYWORDS) && _keywords_exif(d.tagName()));
}

static bool _xmp_out(const Exiv2::Xmpdatum &d, const strip_t what)
{
  return ((what & STRIP_SERIALS) && _personal(d.tagName())) || ((what & STRIP_CAMERA) && _camera_xmp(d))
         || ((what & STRIP_DESCRIPTION) && _description_xmp(d))
         || ((what & STRIP_KEYWORDS) && _keywords_xmp(d));
}

char *strip_metadata(const char *path, const strip_t what)
{
  if(!what) return NULL;
  try
  {
    _lock lock;
#if defined(_WIN32) && defined(EXV_UNICODE_PATH)
    gunichar2 *wide = g_utf8_to_utf16(path, -1, NULL, NULL, NULL);
    auto image = Exiv2::ImageFactory::open(std::wstring((const wchar_t *)wide));
    g_free(wide);
#else
    auto image = Exiv2::ImageFactory::open(path);
#endif
    image->readMetadata();
    bool changed = false;

    Exiv2::ExifData &exif = image->exifData();
    for(auto i = exif.begin(); i != exif.end();)
      if(_exif_out(*i, what))
      {
        i = exif.erase(i);
        changed = true;
      }
      else
        ++i;

    Exiv2::XmpData &xmp = image->xmpData();
    for(auto i = xmp.begin(); i != xmp.end();)
      if(_xmp_out(*i, what))
      {
        i = xmp.erase(i);
        changed = true;
      }
      else
        ++i;

    if(changed) image->writeMetadata();
    return NULL;
  }
  catch(const std::exception &e)
  {
    return g_strdup_printf("could not remove metadata from '%s': %s", path, e.what());
  }
}

// JPEG XL: exiv2 reads its ISO BMFF container but cannot write it, and
// darktable's encoder puts the EXIF and the photo's whole sidecar XMP (edit
// history, location, text) into plain boxes whatever the export's flags say
// (src/imageio/format/jxl.c). so the boxes are edited here and the file
// rewritten around them

static uint32_t _be32(const unsigned char *p)
{
  return (uint32_t)p[0] << 24 | (uint32_t)p[1] << 16 | (uint32_t)p[2] << 8 | p[3];
}

static void _put32(std::string &out, const uint32_t v)
{
  const char b[4] = { (char)(v >> 24), (char)(v >> 16), (char)(v >> 8), (char)v };
  out.append(b, 4);
}

static void _put_box(std::string &out, const char *type, const std::string &payload)
{
  _put32(out, (uint32_t)(payload.size() + 8));
  out.append(type, 4);
  out += payload;
}

// the Exif box: a 4 byte offset, then the TIFF data. exiv2 throws when it
// cannot be read, so the file is not delivered with what could not be checked
static void _jxl_exif(std::string &payload, const strip_t what, bool &changed, bool &keep)
{
  keep = true;
  if(payload.size() < 4) return;
  const Exiv2::byte *data = (const Exiv2::byte *)payload.data() + 4;
  const size_t size = payload.size() - 4;
  Exiv2::ExifData exif;
  const Exiv2::ByteOrder order = Exiv2::ExifParser::decode(exif, data, size);
  bool erased = false;
  for(auto i = exif.begin(); i != exif.end();)
    if(_exif_out(*i, what) || ((what & STRIP_LOCATION) && i->groupName() == "GPSInfo"))
    {
      i = exif.erase(i);
      erased = true;
    }
    else
      ++i;
  if(!erased) return;
  changed = true;
  if(exif.empty())
  {
    keep = false;
    return;
  }
  Exiv2::Blob blob;
  Exiv2::ExifParser::encode(blob, data, size, order, exif);
  payload.assign(4, '\0');
  payload.append((const char *)blob.data(), blob.size());
}

static void _jxl_xmp(std::string &payload, const strip_t what, bool &changed, bool &keep)
{
  keep = true;
  Exiv2::XmpData xmp;
  if(Exiv2::XmpParser::decode(xmp, payload)) throw Exiv2::Error(Exiv2::ErrorCode::kerFailedToReadImageData);
  bool erased = false;
  for(auto i = xmp.begin(); i != xmp.end();)
    if(_xmp_out(*i, what) || ((what & STRIP_HISTORY) && i->groupName() == "darktable")
       || ((what & STRIP_LOCATION) && i->tagName().rfind("GPS", 0) == 0
           && i->groupName() == "exif"))
    {
      i = xmp.erase(i);
      erased = true;
    }
    else
      ++i;
  if(!erased) return;
  changed = true;
  if(xmp.empty())
  {
    keep = false;
    return;
  }
  std::string packet;
  if(Exiv2::XmpParser::encode(packet, xmp)) throw Exiv2::Error(Exiv2::ErrorCode::kerImageWriteFailed);
  payload = packet;
}

char *strip_jxl(const char *path, const strip_t what)
{
  if(!what) return NULL;
  try
  {
    gchar *raw = NULL;
    gsize length = 0;
    GError *error = NULL;
    if(!g_file_get_contents(path, &raw, &length, &error))
    {
      char *message = g_strdup_printf("could not read '%s': %s", path, error->message);
      g_error_free(error);
      return message;
    }
    const std::string file(raw, length);
    g_free(raw);
    const unsigned char *bytes = (const unsigned char *)file.data();
    static const unsigned char signature[12] = { 0, 0, 0, 12, 'J', 'X', 'L', ' ', 0x0D, 0x0A, 0x87, 0x0A };
    // a bare codestream has no boxes, so no metadata
    if(length < 12 || memcmp(bytes, signature, 12)) return NULL;

    std::string out;
    out.reserve(length);
    bool changed = false;
    _lock lock;
    for(size_t pos = 0; pos < length;)
    {
      if(length - pos < 8) throw std::runtime_error("truncated box header");
      uint64_t size = _be32(bytes + pos);
      const char *type = file.data() + pos + 4;
      size_t head = 8;
      if(size == 1)
      {
        if(length - pos < 16) throw std::runtime_error("truncated box header");
        size = (uint64_t)_be32(bytes + pos + 8) << 32 | _be32(bytes + pos + 12);
        head = 16;
      }
      else if(size == 0)
        size = length - pos;
      if(size < head || size > length - pos) throw std::runtime_error("box runs past the end of the file");
      std::string payload = file.substr(pos + head, size - head);
      const bool exif = !memcmp(type, "Exif", 4), xml = !memcmp(type, "xml ", 4);
      // compressed boxes cannot be read here; the file would keep them
      if(!memcmp(type, "brob", 4) && payload.size() >= 4
         && (!memcmp(payload.data(), "Exif", 4) || !memcmp(payload.data(), "xml ", 4)))
        throw std::runtime_error("compressed metadata box");
      bool keep = true, edited = false;
      if(exif) _jxl_exif(payload, what, edited, keep);
      else if(xml) _jxl_xmp(payload, what, edited, keep);
      changed |= edited;
      if(keep && edited) _put_box(out, exif ? "Exif" : "xml ", payload);
      else if(keep) out.append(file, pos, size);
      pos += size;
    }
    if(!changed) return NULL;

    gchar *part = g_strdup_printf("%s.part", path);
    gboolean ok = g_file_set_contents(part, out.data(), out.size(), &error);
    if(!ok)
    {
      char *message = g_strdup_printf("could not remove metadata from '%s': %s", path, error->message);
      g_error_free(error);
      g_free(part);
      return message;
    }
    // g_rename replaces an existing file on Windows too
    if(g_rename(part, path))
    {
      g_unlink(part);
      g_free(part);
      return g_strdup_printf("could not replace '%s'", path);
    }
    g_free(part);
    return NULL;
  }
  catch(const std::exception &e)
  {
    return g_strdup_printf("could not remove metadata from '%s': %s", path, e.what());
  }
}

// Read the generated file before merging EXIF, retaining its ICC profile
// and, for DNG, its version and calibration tags.
gboolean rendered_metadata(const char *path, const void *blob, const int size, const gboolean dng)
{
  if(!blob || size <= 0) return TRUE;
  try
  {
    _lock lock;
#if defined(_WIN32) && defined(EXV_UNICODE_PATH)
    gunichar2 *wide = g_utf8_to_utf16(path, -1, NULL, NULL, NULL);
    auto image = Exiv2::ImageFactory::open(std::wstring((const wchar_t *)wide));
    g_free(wide);
#else
    auto image = Exiv2::ImageFactory::open(path);
#endif
    image->readMetadata();
    Exiv2::ExifData source;
    Exiv2::ExifParser::decode(source, static_cast<const uint8_t *>(blob), size);
    auto &dest = image->exifData();
    for(const auto &d : source)
    {
      // The output owns its layout, color calibration and orientation.
      if(d.groupName() == "Image"
         && (d.tag() >= 50706 || d.tag() == 34675 || d.tagName() == "Orientation"
             || d.tagName() == "Software" || (dng && (d.tagName() == "Make" || d.tagName() == "Model")))) continue;
      const Exiv2::ExifKey key(d.key());
      auto old = dest.findKey(key);
      if(old != dest.end()) dest.erase(old);
      dest.add(key, &d.value());
    }
    image->writeMetadata();
    return TRUE;
  }
  catch(const std::exception &)
  {
    return FALSE;
  }
}

static uint16_t _exif_orientation(const int orientation)
{
  // darktable's flip bits, in EXIF's orientation order.
  switch(orientation)
  {
    case ORIENTATION_NONE: return 1; // top-left
    case ORIENTATION_FLIP_X: return 2; // top-right
    case ORIENTATION_ROTATE_180_DEG: return 3; // bottom-right
    case ORIENTATION_FLIP_Y: return 4; // bottom-left
    case ORIENTATION_TRANSPOSE: return 5; // left-top
    case ORIENTATION_ROTATE_CW_90_DEG: return 6; // right-top
    case ORIENTATION_TRANSVERSE: return 7; // right-bottom
    case ORIENTATION_ROTATE_CCW_90_DEG: return 8; // left-bottom
    default: return 1;
  }
}

gboolean dng_orientation_metadata(const char *path, const int orientation)
{
  try
  {
    _lock lock;
#if defined(_WIN32) && defined(EXV_UNICODE_PATH)
    gunichar2 *wide = g_utf8_to_utf16(path, -1, NULL, NULL, NULL);
    auto image = Exiv2::ImageFactory::open(std::wstring((const wchar_t *)wide));
    g_free(wide);
#else
    auto image = Exiv2::ImageFactory::open(path);
#endif
    image->readMetadata();
    image->exifData()["Exif.Image.Orientation"] = _exif_orientation(orientation);
    image->writeMetadata();
    return TRUE;
  }
  catch(const std::exception &) { return FALSE; }
}

gboolean denoised_metadata(const char *path, const int orientation)
{
  try
  {
    _lock lock;
#if defined(_WIN32) && defined(EXV_UNICODE_PATH)
    gunichar2 *wide = g_utf8_to_utf16(path, -1, NULL, NULL, NULL);
    auto image = Exiv2::ImageFactory::open(std::wstring((const wchar_t *)wide));
    g_free(wide);
#else
    auto image = Exiv2::ImageFactory::open(path);
#endif
    image->readMetadata();
    image->exifData()["Exif.Image.Orientation"] = _exif_orientation(orientation);
    // Keep the source ISO, but prevent automatic denoise presets from
    // processing pixels that the model has already denoised.
    image->xmpData()["Xmp.darktable.neural_restore"] = "raw-denoise";
    image->writeMetadata();
    return TRUE;
  }
  catch(const std::exception &) { return FALSE; }
}

// XMP has no standard deletion value for GPS. Mark Immage sidecars as
// authoritative so missing fields override GPS embedded in the source.
gboolean location_sidecar_mark(const char *path)
{
  try
  {
    _lock lock;
    Exiv2::XmpProperties::registerNs("https://github.com/Rhettus/immage/ns/1.0/", "immage");
    auto image = Exiv2::ImageFactory::open(path);
    if(!image.get()) return FALSE;
    image->readMetadata();
    image->xmpData()["Xmp.immage.locationManaged"] = "True";
    image->writeMetadata();
    return TRUE;
  }
  catch(const std::exception &) { return FALSE; }
}

int location_sidecar_missing(const char *path)
{
  try
  {
    _lock lock;
    Exiv2::XmpProperties::registerNs("https://github.com/Rhettus/immage/ns/1.0/", "immage");
    auto image = Exiv2::ImageFactory::open(path);
    if(!image.get()) return 0;
    image->readMetadata();
    auto &xmp = image->xmpData();
    auto managed = xmp.findKey(Exiv2::XmpKey("Xmp.immage.locationManaged"));
    if(managed == xmp.end() || managed->toString() != "True") return 0;
    int missing = 0;
    if(xmp.findKey(Exiv2::XmpKey("Xmp.exif.GPSLatitude")) == xmp.end()
       || xmp.findKey(Exiv2::XmpKey("Xmp.exif.GPSLongitude")) == xmp.end()) missing |= 1;
    if(xmp.findKey(Exiv2::XmpKey("Xmp.exif.GPSAltitude")) == xmp.end()) missing |= 2;
    return missing;
  }
  catch(const std::exception &) { return 0; }
}

// Called on request/import threads. Cache source metadata across virtual copies
// and repeated meta replies; source changes invalidate it, sidecar edits do not.
char *camera_body_serial(const char *path)
{
  _lock lock; // Protect both Exiv2 and the cache across request/import threads.
  struct Entry { gint64 mtime; gint64 ctime; gint64 size; std::string serial; };
  static std::map<std::string, Entry> cache;
  GStatBuf st;
  if(g_stat(path, &st)) return g_strdup("");
  const auto hit = cache.find(path);
  if(hit != cache.end() && hit->second.mtime == st.st_mtime
     && hit->second.ctime == st.st_ctime && hit->second.size == st.st_size)
    return g_strdup(hit->second.serial.c_str());
  std::string serial;
  try
  {
    auto image = Exiv2::ImageFactory::open(path);
    if(image)
    {
      image->readMetadata();
      const auto &exif = image->exifData();
      auto it = exif.findKey(Exiv2::ExifKey("Exif.Photo.BodySerialNumber"));
      if(it == exif.end()) it = exif.findKey(Exiv2::ExifKey("Exif.Image.CameraSerialNumber"));
      if(it == exif.end()) it = Exiv2::serialNumber(exif);
      if(it != exif.end()) serial = it->print(&exif);
    }
  }
  catch(const Exiv2::Error &) { /* Missing or unsupported metadata is unknown. */ }
  gchar *trimmed = g_strdup(serial.c_str());
  g_strstrip(trimmed);
  serial = trimmed;
  g_free(trimmed);
  // Common placeholders must not pretend to identify a physical body.
  if(serial == "n/a" || serial == "Unknown" || serial == "unknown"
     || (!serial.empty() && serial.find_first_not_of("0 ") == std::string::npos)) serial.clear();
  if(cache.size() >= 4096) cache.clear();
  cache[path] = { st.st_mtime, st.st_ctime, st.st_size, serial };
  return g_strdup(serial.c_str());
}
