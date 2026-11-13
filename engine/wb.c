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
#include "common/wb_presets.h"

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
// no matrix; here reading gives 0 (the card hides the sliders) and writing
// is an error, as the fields would be nonsense
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
  dt_introspection_field_t *f = NULL;
  p = session_field_in(mod, from_defaults ? mod->default_params : mod->params, "red", &f, err);
  if(!p) return FALSE;
  // an error here would fail the card's whole read, not just these two fields
  if(!_prepare_matrices(&mod->dev->image_storage, &m))
  {
    *num = 0.0;
    return TRUE;
  }
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

// the settings combobox and finetune slider, from temperature.c's
// _generate_preset_combo, gui_update and _preset_tune_callback. the headless
// engine has no gui_data, so the combobox is rebuilt from the preset store
// (dt_wb_presets_init runs in dt_init) each time. a setting is the combobox
// index: 0 as shot, 2 user modified, 3 camera reference, 4 as shot to
// reference, and 6 + k for the k-th camera preset (index 5 is the section
// header, index 1 "from image area" needs the color picker and is not offered)
#define WB_AS_SHOT 0
#define WB_D65 3
#define WB_D65_LATE 4
#define WB_NUM_STD 5
#define WB_FIRST_CAMERA (WB_NUM_STD + 1)
#define WB_MAX_PRESETS 50

typedef struct
{
  int first;  // preset_num: the first (lowest tuning) store entry
  int min_ft_pos, no_ft_pos, max_ft_pos;
} _preset_t;

static gboolean _same_camera(const dt_image_t *img, const dt_wb_data *w)
{
  return !strcmp(w->make, img->camera_maker) && !strcmp(w->model, img->camera_model);
}

// temperature.c: _generate_preset_combo, without the widget
static int _camera_presets(const dt_image_t *img, _preset_t out[WB_MAX_PRESETS])
{
  int found = 0;
  const int count = dt_wb_presets_count();
  const char *wb_name = NULL;
  if(dt_image_is_ldr(img)) return 0;
  for(int i = 0; i < count; i++)
  {
    if(found >= WB_MAX_PRESETS) break;
    const dt_wb_data *wbp = dt_wb_preset(i);
    if(!_same_camera(img, wbp)) continue;
    if(wb_name && !strcmp(wb_name, wbp->name)) continue;
    wb_name = wbp->name;
    _preset_t *pr = &out[found++];
    pr->first = pr->no_ft_pos = pr->max_ft_pos = pr->min_ft_pos = i;
    if(wbp->tuning != 0)
    {
      // wb_presets is ordered, so the minimum tuning comes first; the bound
      // check is ours, darktable's loop trusts the store to end on a new name
      int ft_pos = i;
      int last_ft = wbp->tuning;
      pr->min_ft_pos = ft_pos++;
      while(ft_pos < count && !strcmp(wb_name, dt_wb_preset(ft_pos)->name))
      {
        if(dt_wb_preset(ft_pos)->tuning == 0) pr->no_ft_pos = ft_pos;
        if(dt_wb_preset(ft_pos)->tuning > last_ft)
        {
          pr->max_ft_pos = ft_pos;
          last_ft = dt_wb_preset(ft_pos)->tuning;
        }
        ft_pos++;
      }
    }
  }
  return found;
}

static gboolean _equal(const _wb_params_t *p, const double *d)
{
  return dt_dev_equal_chroma(p->coeff, d);
}

// temperature.c: _temp_params_from_array, which copies all four, even where
// the fourth is meaningless
static void _from_array(_wb_params_t *p, const double a[4])
{
  for(int c = 0; c < 4; c++) p->coeff[c] = (float)a[c];
}

// the coefficients of preset pr at a tuning, as _preset_tune_callback: an exact
// variant, else interpolated between the variants around it; with neither,
// FALSE and darktable leaves the coefficients as they are
static gboolean _apply_tuning(const dt_image_t *img, const _preset_t *pr, const int tune, double ch[4])
{
  const int count = dt_wb_presets_count();
  const char *name = dt_wb_preset(pr->no_ft_pos)->name;
  for(int i = pr->min_ft_pos; i < pr->max_ft_pos + 1 && i < count; i++)
  {
    const dt_wb_data *w = dt_wb_preset(i);
    if(!_same_camera(img, w) || strcmp(w->name, name)) break;
    if(w->tuning == tune)
    {
      memcpy(ch, w->channels, 4 * sizeof(double));
      return TRUE;
    }
  }
  for(int i = pr->min_ft_pos + 1; i < pr->max_ft_pos + 1 && i < count; i++)
  {
    const dt_wb_data *lo = dt_wb_preset(i - 1), *hi = dt_wb_preset(i);
    if(!_same_camera(img, hi) || strcmp(hi->name, name)) break;
    if(lo->tuning < tune && hi->tuning > tune)
    {
      dt_wb_data out = { .tuning = tune };
      dt_wb_preset_interpolate(lo, hi, &out);
      memcpy(ch, out.channels, 4 * sizeof(double));
      return TRUE;
    }
  }
  return FALSE;
}

// temperature.c: gui_update's matching of the coefficients to an entry; it
// only reads (darktable also stores the preset it settles on, which the next
// edit would overwrite anyway)
static int _match(const dt_image_t *img, const dt_dev_chroma_t *chr, const _wb_params_t *p,
                  const _preset_t *pr, const int n, int *tuning)
{
  *tuning = 0;
  if(_equal(p, chr->as_shot) && p->preset == WB_D65_LATE) return WB_D65_LATE;
  if(_equal(p, chr->as_shot)) return WB_AS_SHOT;
  if(_equal(p, chr->D65coeffs)) return WB_D65;
  const int count = dt_wb_presets_count();
  for(int j = 0; j < n; j++)
  {
    for(int i = pr[j].first; i < count; i++)
    {
      const dt_wb_data *w = dt_wb_preset(i);
      if(!_same_camera(img, w) || strcmp(w->name, dt_wb_preset(pr[j].first)->name)) break;
      if(dt_dev_equal_chroma(p->coeff, w->channels))
      {
        *tuning = w->tuning;
        return WB_FIRST_CAMERA + j;
      }
    }
  }
  // not an exact variant: maybe interpolated across a gap in the tunings,
  // which gives no way to know the tuning but to try each one
  for(int j = 0; j < n; j++)
  {
    for(int i = pr[j].first + 1; i < count; i++)
    {
      const dt_wb_data *lo = dt_wb_preset(i - 1), *hi = dt_wb_preset(i);
      if(!_same_camera(img, hi) || strcmp(hi->name, dt_wb_preset(pr[j].first)->name)) break;
      for(int tune = lo->tuning + 1; tune < hi->tuning; tune++)
      {
        dt_wb_data out = { .tuning = tune };
        dt_wb_preset_interpolate(lo, hi, &out);
        if(dt_dev_equal_chroma(p->coeff, out.channels))
        {
          *tuning = tune;
          return WB_FIRST_CAMERA + j;
        }
      }
    }
  }
  return WB_PRESET_USER;
}

gboolean wb_setting_read(dt_iop_module_t *mod, const char *name, const gboolean from_defaults,
                         double *num, char **err)
{
  dt_introspection_field_t *f = NULL;
  const _wb_params_t *p = session_field_in(mod, from_defaults ? mod->default_params : mod->params,
                                           "red", &f, err);
  if(!p) return FALSE;
  const dt_image_t *img = &mod->dev->image_storage;
  _preset_t pr[WB_MAX_PRESETS];
  const int n = _camera_presets(img, pr);
  int tune;
  const int setting = _match(img, &mod->dev->chroma, p, pr, n, &tune);
  *num = !strcmp(name, WB_SETTING) ? setting : tune;
  return TRUE;
}

// temperature.c: _preset_tune_callback. setting 2 keeps the coefficients, as
// darktable's user branch rewrites them from its own copy of the same values
gboolean wb_setting_write(dt_iop_module_t *mod, const char *name, const double num, char **err)
{
  dt_introspection_field_t *f = NULL;
  _wb_params_t *p = session_field_in(mod, mod->params, "red", &f, err);
  if(!p) return FALSE;
  const dt_image_t *img = &mod->dev->image_storage;
  const dt_dev_chroma_t *chr = &mod->dev->chroma;
  _preset_t pr[WB_MAX_PRESETS];
  const int n = _camera_presets(img, pr);
  const int value = (int)lround(num);

  if(!strcmp(name, WB_TUNE))
  {
    int tune;
    const int setting = _match(img, chr, p, pr, n, &tune);
    if(setting < WB_FIRST_CAMERA)
    {
      *err = g_strdup("white balance is not a camera preset");
      return FALSE;
    }
    const _preset_t *cur = &pr[setting - WB_FIRST_CAMERA];
    const int lo = dt_wb_preset(cur->min_ft_pos)->tuning, hi = dt_wb_preset(cur->max_ft_pos)->tuning;
    double ch[4];
    if(_apply_tuning(img, cur, CLAMP(value, lo, hi), ch)) _from_array(p, ch);
    p->preset = setting;
    return TRUE;
  }

  switch(value)
  {
    case WB_AS_SHOT:
    case WB_D65_LATE:
      _from_array(p, chr->as_shot);
      break;
    case WB_D65:
      _from_array(p, chr->D65coeffs);
      break;
    case WB_PRESET_USER:
      break;
    default:
      if(value >= WB_FIRST_CAMERA && value - WB_FIRST_CAMERA < n)
      {
        double ch[4];
        if(_apply_tuning(img, &pr[value - WB_FIRST_CAMERA], 0, ch)) _from_array(p, ch);
        break;
      }
      *err = g_strdup("unknown white balance setting");
      return FALSE;
  }
  p->preset = value;
  return TRUE;
}

// a direct edit of a coefficient is "user modified", temperature.c: gui_changed
void wb_mark_user(dt_iop_module_t *mod)
{
  dt_introspection_field_t *f = NULL;
  char *err = NULL;
  _wb_params_t *p = session_field_in(mod, mod->params, "red", &f, &err);
  g_free(err);
  if(p) p->preset = WB_PRESET_USER;
}

// the camera presets of the open photo, for the settings menu
gboolean wb_presets(JsonBuilder *b, char **err)
{
  dt_iop_module_t *mod = session_module("temperature", err);
  if(!mod) return FALSE;
  _preset_t pr[WB_MAX_PRESETS];
  const int n = _camera_presets(&mod->dev->image_storage, pr);
  json_builder_set_member_name(b, "presets");
  json_builder_begin_array(b);
  for(int k = 0; k < n; k++)
  {
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "name");
    json_builder_add_string_value(b, dt_wb_preset(pr[k].first)->name);
    json_builder_set_member_name(b, "value");
    json_builder_add_int_value(b, WB_FIRST_CAMERA + k);
    json_builder_set_member_name(b, "tune_min");
    json_builder_add_int_value(b, dt_wb_preset(pr[k].min_ft_pos)->tuning);
    json_builder_set_member_name(b, "tune_max");
    json_builder_add_int_value(b, dt_wb_preset(pr[k].max_ft_pos)->tuning);
    json_builder_set_member_name(b, "tune_default");
    json_builder_add_int_value(b, dt_wb_preset(pr[k].no_ft_pos)->tuning);
    json_builder_end_object(b);
  }
  json_builder_end_array(b);
  return TRUE;
}
