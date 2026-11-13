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

// white balance temperature and tint, ported from darktable's temperature.c.
// darktable computes them only with its GUI (the matrices live in the
// module's gui_data, filled by gui_init), which the headless engine never
// runs, so the same math is repeated here on top of the module's params.
// Keep it identical to temperature.c, quirks included.

#include "engine.h"

// for the Kelvin conversions, as temperature.c:43; the tables are static
#include "external/cie_colorimetric_tables.c"

#define INITIALBLACKBODYTEMPERATURE 4000
#define DT_IOP_LOWEST_TEMPERATURE 1901
#define DT_IOP_HIGHEST_TEMPERATURE 25000
#define DT_IOP_LOWEST_TINT 0.135
#define DT_IOP_HIGHEST_TINT 2.326

// dt_iop_temperature_params_t (temperature.c:67), whose four coefficients
// _temp_array_from_params reads as an array, and the preset that
// DT_IOP_TEMP_USER names (temperature.c:61)
typedef struct
{
  float coeff[4];
  int preset;
} _wb_params_t;
#define WB_PRESET_USER 2

typedef struct
{
  double XYZ_to_CAM[4][3];
  double CAM_to_XYZ[3][4];
} _matrices_t;

typedef double (*_spd)(unsigned long int wavelength, double TempK);

// temperature.c: _spd_blackbody
static double _spd_blackbody(unsigned long int wavelength, double TempK)
{
  const long double lambda = (double)wavelength * 1e-9;
#define c1 3.7417715246641281639549488324352159753e-16L
#define c2 0.014387769599838156481252937624049081933L
  return (double)(c1 / (powl(lambda, 5) * (expl(c2 / (lambda * TempK)) - 1.0L)));
#undef c2
#undef c1
}

// temperature.c: _spd_daylight
static double _spd_daylight(unsigned long int wavelength, double TempK)
{
  cmsCIExyY WhitePoint = { D65xyY.x, D65xyY.y, 1.0 };
  cmsWhitePointFromTemp(&WhitePoint, TempK);

  const double M = (0.0241 + 0.2562 * WhitePoint.x - 0.7341 * WhitePoint.y),
               m1 = (-1.3515 - 1.7703 * WhitePoint.x + 5.9114 * WhitePoint.y) / M,
               m2 = (0.0300 - 31.4424 * WhitePoint.x + 30.0717 * WhitePoint.y) / M;

  const unsigned long int j = ((wavelength - cie_daylight_components[0].wavelength)
                               / (cie_daylight_components[1].wavelength
                                  - cie_daylight_components[0].wavelength));

  return cie_daylight_components[j].S[0] + m1 * cie_daylight_components[j].S[1]
         + m2 * cie_daylight_components[j].S[2];
}

// temperature.c: _spectrum_to_XYZ
static cmsCIEXYZ _spectrum_to_XYZ(const double TempK, const _spd I)
{
  cmsCIEXYZ Source = { .X = 0.0, .Y = 0.0, .Z = 0.0 };

  for(size_t i = 0; i < cie_1931_std_colorimetric_observer_count; i++)
  {
    const unsigned long int lambda = cie_1931_std_colorimetric_observer[0].wavelength
      + (cie_1931_std_colorimetric_observer[1].wavelength
         - cie_1931_std_colorimetric_observer[0].wavelength) * i;

    const double P = I(lambda, TempK);
    Source.X += P * cie_1931_std_colorimetric_observer[i].xyz.X;
    Source.Y += P * cie_1931_std_colorimetric_observer[i].xyz.Y;
    Source.Z += P * cie_1931_std_colorimetric_observer[i].xyz.Z;
  }

  const double _max = fmax(fmax(Source.X, Source.Y), Source.Z);
  Source.X /= _max;
  Source.Y /= _max;
  Source.Z /= _max;
  return Source;
}

// temperature.c: _temperature_to_XYZ; blackbody below 4000 K, as darktable
// has no daylight reference there
static cmsCIEXYZ _temperature_to_XYZ(double TempK)
{
  if(TempK < DT_IOP_LOWEST_TEMPERATURE) TempK = DT_IOP_LOWEST_TEMPERATURE;
  if(TempK > DT_IOP_HIGHEST_TEMPERATURE) TempK = DT_IOP_HIGHEST_TEMPERATURE;

  return _spectrum_to_XYZ(TempK, TempK < INITIALBLACKBODYTEMPERATURE ? _spd_blackbody : _spd_daylight);
}

// temperature.c: _XYZ_to_temperature, a binary search
static void _XYZ_to_temperature(const cmsCIEXYZ XYZ, float *TempK, float *tint)
{
  double maxtemp = DT_IOP_HIGHEST_TEMPERATURE, mintemp = DT_IOP_LOWEST_TEMPERATURE;
  cmsCIEXYZ _xyz;

  for(*TempK = (maxtemp + mintemp) / 2.0; (maxtemp - mintemp) > 1.0;
      *TempK = (maxtemp + mintemp) / 2.0)
  {
    _xyz = _temperature_to_XYZ(*TempK);
    if(_xyz.Z / _xyz.X > XYZ.Z / XYZ.X)
      maxtemp = *TempK;
    else
      mintemp = *TempK;
  }

  *tint = (_xyz.Y / _xyz.X) / (XYZ.Y / XYZ.X);

  if(*TempK < DT_IOP_LOWEST_TEMPERATURE) *TempK = DT_IOP_LOWEST_TEMPERATURE;
  if(*TempK > DT_IOP_HIGHEST_TEMPERATURE) *TempK = DT_IOP_HIGHEST_TEMPERATURE;
  if(*tint < DT_IOP_LOWEST_TINT) *tint = DT_IOP_LOWEST_TINT;
  if(*tint > DT_IOP_HIGHEST_TINT) *tint = DT_IOP_HIGHEST_TINT;
}

// temperature.c: _prepare_matrices, which logs and carries on when a raw has
// no matrix; here that is an error, as the fields would read nonsense
static gboolean _prepare_matrices(const dt_image_t *img, _matrices_t *m)
{
  static const double RGB_to_XYZ[3][4] = { { 0.4124564, 0.3575761, 0.1804375, 0 },
                                           { 0.2126729, 0.7151522, 0.0721750, 0 },
                                           { 0.0193339, 0.1191920, 0.9503041, 0 } };
  static const double XYZ_to_RGB[4][3] = { { 3.2404542, -1.5371385, -0.4985314 },
                                           { -0.9692660, 1.8760108, 0.0415560 },
                                           { 0.0556434, -0.2040259, 1.0572252 },
                                           { 0, 0, 0 } };

  if(!dt_image_is_raw(img))
  {
    memcpy(m->XYZ_to_CAM, XYZ_to_RGB, sizeof m->XYZ_to_CAM);
    memcpy(m->CAM_to_XYZ, RGB_to_XYZ, sizeof m->CAM_to_XYZ);
    return TRUE;
  }
  return dt_colorspaces_conversion_matrices_xyz(img->adobe_XYZ_to_CAM, (float *)img->d65_color_matrix,
                                                m->XYZ_to_CAM, m->CAM_to_XYZ);
}

// temperature.c: _mul2temp over _mul2xyz
static void _mul2temp(const _matrices_t *m, const _wb_params_t *p, float *TempK, float *tint)
{
  double CAM[4];
  for(int k = 0; k < 4; k++) CAM[k] = p->coeff[k] > 0.0f ? 1.0 / p->coeff[k] : 0.0f;

  double XYZ[3];
  for(int k = 0; k < 3; k++)
  {
    XYZ[k] = 0.0;
    for(int i = 0; i < 4; i++) XYZ[k] += m->CAM_to_XYZ[k][i] * CAM[i];
  }
  _XYZ_to_temperature((cmsCIEXYZ){ XYZ[0], XYZ[1], XYZ[2] }, TempK, tint);
}

// temperature.c: _temp2mul over _xyz2mul
static void _temp2mul(const _matrices_t *m, const double TempK, const double tint, double mul[4])
{
  cmsCIEXYZ xyz = _temperature_to_XYZ(TempK);
  xyz.Y /= tint; // darktable's own tint hack, not orthogonal to the locus
  const double XYZ[3] = { xyz.X, xyz.Y, xyz.Z };

  for(int k = 0; k < 4; k++)
  {
    double CAM = 0.0;
    for(int i = 0; i < 3; i++) CAM += m->XYZ_to_CAM[k][i] * XYZ[i];
    mul[k] = 1.0 / CAM;
  }
}

static gboolean _setup(dt_iop_module_t *mod, void *base, _wb_params_t **p, _matrices_t *m, char **err)
{
  dt_introspection_field_t *f = NULL;
  *p = session_field_in(mod, base, "red", &f, err);
  if(!*p) return FALSE;
  if(!_prepare_matrices(&mod->dev->image_storage, m))
  {
    *err = g_strdup("no color matrix for this image, so no white balance temperature");
    return FALSE;
  }
  return TRUE;
}

gboolean wb_read(dt_iop_module_t *mod, const char *name, const gboolean from_defaults, double *num,
                 char **err)
{
  _wb_params_t *p;
  _matrices_t m;
  if(!_setup(mod, from_defaults ? mod->default_params : mod->params, &p, &m, err)) return FALSE;
  float temp, tint;
  _mul2temp(&m, p, &temp, &tint);
  *num = !strcmp(name, WB_TEMP) ? temp : tint;
  // all-zero coefficients (some defaults) give no white point: read 0, not NaN
  if(!isfinite(*num)) *num = 0.0;
  return TRUE;
}

// temperature.c: _temp_tint_callback, which takes both sliders, makes the
// coefficients green-relative and marks the setting as user defined
// (_update_preset). the other value is the one the params read now
gboolean wb_write(dt_iop_module_t *mod, const char *name, const double num, char **err)
{
  _wb_params_t *p;
  _matrices_t m;
  if(!_setup(mod, mod->params, &p, &m, err)) return FALSE;
  float temp, tint;
  _mul2temp(&m, p, &temp, &tint);
  const gboolean is_temp = !strcmp(name, WB_TEMP);
  if(is_temp)
    temp = CLAMP(num, DT_IOP_LOWEST_TEMPERATURE, DT_IOP_HIGHEST_TEMPERATURE);
  else
    tint = CLAMP(num, DT_IOP_LOWEST_TINT, DT_IOP_HIGHEST_TINT);

  double mul[4];
  _temp2mul(&m, temp, tint, mul);
  mul[0] /= mul[1];
  mul[2] /= mul[1];
  mul[3] /= mul[1];
  mul[1] = 1.0;

  // the fourth coefficient belongs to 4-color sensors only; elsewhere its
  // matrix row is zero and the multiplier infinite
  const int n = (mod->dev->image_storage.flags & DT_IMAGE_4BAYER) ? 4 : 3;
  for(int k = 0; k < n; k++) p->coeff[k] = (float)mul[k];
  p->preset = WB_PRESET_USER;
  return TRUE;
}
