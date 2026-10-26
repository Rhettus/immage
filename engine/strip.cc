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

#include <string>

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
