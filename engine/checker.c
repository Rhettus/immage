// SPDX-License-Identifier: GPL-3.0-or-later
/*
  This file is part of darktable,
  Copyright (C) 2010-2026 darktable developers.

  darktable is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  darktable is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with darktable.  If not, see <http://www.gnu.org/licenses/>.
*/

// Calibration math copied from src/iop/channelmixerrgb.c at 1c4eaea9df.
// The engine supplies the sampled pipe image and returns numeric results.
#include "engine.h"
#include "chart/colorchart.h"
#include "common/chromatic_adaptation.h"
#include "common/colorchecker.h"
#define pair_min checker_pair_min
#include "common/illuminants.h"
#undef pair_min
#include "develop/imageop_math.h"
#include "develop/openmp_maths.h"
#include "iop/gaussian_elimination.h"

// Perspective mapping from darktable src/chart/common.c.
// using SVD to solve the system with h[8] also being 0 would be better, but this seems to be good enough
static int get_homography(const point_t *source, const point_t *target, float *h)
{
  // Use double precision internally when solving for the homography
  // to avoid numerical instabilities.
  const double x1 = source[0].x;
  const double y1 = source[0].y;
  const double x2 = source[1].x;
  const double y2 = source[1].y;
  const double x3 = source[2].x;
  const double y3 = source[2].y;
  const double x4 = source[3].x;
  const double y4 = source[3].y;

  const double x_1 = target[0].x;
  const double y_1 = target[0].y;
  const double x_2 = target[1].x;
  const double y_2 = target[1].y;
  const double x_3 = target[2].x;
  const double y_3 = target[2].y;
  const double x_4 = target[3].x;
  const double y_4 = target[3].y;

  double P[9*9] = { -x1, -y1, -1.0, 0.0, 0.0,  0.0, x1 * x_1, y1 * x_1, x_1,
                    0.0, 0.0,  0.0, -x1, -y1, -1.0, x1 * y_1, y1 * y_1, y_1,
                    -x2, -y2, -1.0, 0.0, 0.0,  0.0, x2 * x_2, y2 * x_2, x_2,
                    0.0, 0.0,  0.0, -x2, -y2, -1.0, x2 * y_2, y2 * y_2, y_2,
                    -x3, -y3, -1.0, 0.0, 0.0,  0.0, x3 * x_3, y3 * x_3, x_3,
                    0.0, 0.0,  0.0, -x3, -y3, -1.0, x3 * y_3, y3 * y_3, y_3,
                    -x4, -y4, -1.0, 0.0, 0.0,  0.0, x4 * x_4, y4 * x_4, x_4,
                    0.0, 0.0,  0.0, -x4, -y4, -1.0, x4 * y_4, y4 * y_4, y_4,
                    0.0, 0.0,  0.0, 0.0, 0.0,  0.0,      0.0,      0.0, 1.0};

  double h_tmp[9];
  for(int i = 0; i < 8; i++) h_tmp[i] = 0.0;
  h_tmp[8] = 1.0;

  int err_code = gauss_solve(P, h_tmp, 9);
  if(err_code) for(int i = 0; i < 9; i++) h[i] = h_tmp[i];
  return err_code;
}

static point_t apply_homography(point_t p, const float *h)
{
  const float s =  p.x * h[2 * 3 + 0] + p.y * h[2 * 3 + 1] + h[2 * 3 + 2];
  const float x = (p.x * h[0 * 3 + 0] + p.y * h[0 * 3 + 1] + h[0 * 3 + 2]) / s;
  const float y = (p.x * h[1 * 3 + 0] + p.y * h[1 * 3 + 1] + h[1 * 3 + 2]) / s;

  const point_t result = {.x=x, .y=y};

  return result;
}

typedef enum dt_solving_strategy_t
{
  DT_SOLVE_OPTIMIZE_NONE = 0,
  DT_SOLVE_OPTIMIZE_LOW_SAT = 1,
  DT_SOLVE_OPTIMIZE_HIGH_SAT = 2,
  DT_SOLVE_OPTIMIZE_SKIN = 3,
  DT_SOLVE_OPTIMIZE_FOLIAGE = 4,
  DT_SOLVE_OPTIMIZE_SKY = 5,
  DT_SOLVE_OPTIMIZE_AVG_DELTA_E = 6,
  DT_SOLVE_OPTIMIZE_MAX_DELTA_E = 7,
} dt_solving_strategy_t;


typedef struct checker_fit_t
{
  dt_color_checker_t *checker;
  dt_solving_strategy_t optimization;
  float safety_margin;
  float exposure_ev, black;
  float homography[9], inverse_homography[9];
  float *delta_E_in;
  float colorchecker_xy[2];
  dt_colormatrix_t mix;
} checker_fit_t;

static void _check_if_close_to_daylight(const float x,
                                        const float y,
                                        float *temperature,
                                        dt_illuminant_t *illuminant,
                                        dt_adaptation_t *adaptation)
{
  /* Check if a chromaticity x, y is close to daylight within 2.5 % error margin.
   * If so, we enable the daylight GUI for better ergonomics
   * Otherwise, we default to direct x, y control for better accuracy
   *
   * Note : The use of CCT is discouraged if dE > 5 % in CIE 1960 Yuv space
   *        reference : https://onlinelibrary.wiley.com/doi/abs/10.1002/9780470175637.ch3
   */

  // Get the correlated color temperature (CCT)
  float t = xy_to_CCT(x, y);

  // xy_to_CCT is valid only in 3000 - 25000 K. We need another model below
  if(t < 3000.f && t > 1667.f)
    t = CCT_reverse_lookup(x, y);

  if(temperature)
    *temperature = t;

  // Convert to CIE 1960 Yuv space
  const float xy_ref[2] = { x, y };
  float uv_ref[2];
  xy_to_uv(xy_ref, uv_ref);

  float xy_test[2] = { 0.f };
  float uv_test[2];

  // Compute the test chromaticity from the daylight model
  illuminant_to_xy(DT_ILLUMINANT_D, NULL, NULL, &xy_test[0], &xy_test[1], t,
                   DT_ILLUMINANT_FLUO_LAST, DT_ILLUMINANT_LED_LAST);
  xy_to_uv(xy_test, uv_test);

  // Compute the error between the reference illuminant and the test
  // illuminant derivated from the CCT with daylight model
  const float delta_daylight = dt_fast_hypotf(uv_test[0] - uv_ref[0], uv_test[1] - uv_ref[1]);

  // Compute the test chromaticity from the blackbody model
  illuminant_to_xy(DT_ILLUMINANT_BB, NULL, NULL, &xy_test[0], &xy_test[1], t,
                   DT_ILLUMINANT_FLUO_LAST, DT_ILLUMINANT_LED_LAST);
  xy_to_uv(xy_test, uv_test);

  // Compute the error between the reference illuminant and the test
  // illuminant derivated from the CCT with black body model
  const float delta_bb = dt_fast_hypotf(uv_test[0] - uv_ref[0], uv_test[1] - uv_ref[1]);

  // Check the error between original and test chromaticity
  if(delta_bb < 0.005f || delta_daylight < 0.005f)
  {
    if(illuminant)
    {
      if(delta_bb < delta_daylight)
        *illuminant = DT_ILLUMINANT_BB;
      else
        *illuminant = DT_ILLUMINANT_D;
    }
  }
  else
  {
    // error is too big to use a CCT-based model, we fall back to a
    // custom/freestyle chroma selection for the illuminant
    if(illuminant) *illuminant = DT_ILLUMINANT_CUSTOM;
  }

  // CAT16 is more accurate no matter the illuminant
  if(adaptation) *adaptation = DT_ADAPTATION_CAT16;
}

static inline void _compute_patches_delta_E(const float *const restrict patches,
                                            const dt_color_checker_t *const checker,
                                            float *const restrict delta_E,
                                            float *const restrict avg_delta_E,
                                            float *const restrict max_delta_E)
{
  // Compute the delta E

  float dE = 0.f;
  float max_dE = 0.f;

  for(size_t k = 0; k < checker->patches; k++)
  {
    // Convert to Lab
    dt_aligned_pixel_t Lab_test;
    dt_aligned_pixel_t XYZ_test;

    // If exposure was normalized, denormalized it before
    for(size_t c = 0; c < 4; c++) XYZ_test[c] = patches[k * 4 + c];
    dt_XYZ_to_Lab(XYZ_test, Lab_test);

    const float *const restrict Lab_ref = checker->values[k].Lab;

    // Compute delta E 2000 to make your computer heat
    // ref: https://en.wikipedia.org/wiki/Color_difference#CIEDE2000
    // note : it will only be luck if I didn't mess-up the computation somewhere
    const float DL = Lab_ref[0] - Lab_test[0];
    const float L_avg = (Lab_ref[0] + Lab_test[0]) / 2.f;
    const float C_ref = dt_fast_hypotf(Lab_ref[1], Lab_ref[2]);
    const float C_test = dt_fast_hypotf(Lab_test[1], Lab_test[2]);
    const float C_avg = (C_ref + C_test) / 2.f;
    float C_avg_7 = C_avg * C_avg; // C_avg²
    C_avg_7 *= C_avg_7;            // C_avg⁴
    C_avg_7 *= C_avg_7;            // C_avg⁸
    C_avg_7 /= C_avg;              // C_avg⁷
    // 25⁷ = 6103515625
    const float C_avg_7_ratio_sqrt = sqrtf(C_avg_7 / (C_avg_7 + 6103515625.f));
    const float a_ref_prime = Lab_ref[1] * (1.f + 0.5f * (1.f - C_avg_7_ratio_sqrt));
    const float a_test_prime = Lab_test[1] * (1.f + 0.5f * (1.f - C_avg_7_ratio_sqrt));
    const float C_ref_prime = dt_fast_hypotf(a_ref_prime, Lab_ref[2]);
    const float C_test_prime = dt_fast_hypotf(a_test_prime, Lab_test[2]);
    const float DC_prime = C_ref_prime - C_test_prime;
    const float C_avg_prime = (C_ref_prime + C_test_prime) / 2.f;
    float h_ref_prime = atan2f(Lab_ref[2], a_ref_prime);
    float h_test_prime = atan2f(Lab_test[2], a_test_prime);

    // Comply with recommendations, h = 0° where C = 0 by convention
    if(C_ref_prime == 0.f) h_ref_prime = 0.f;
    if(C_test_prime == 0.f) h_test_prime = 0.f;

    // Get the hue angles from [-pi ; pi] back to [0 ; 2 pi],
    // again, to comply with specifications
    if(h_ref_prime < 0.f) h_ref_prime = DT_2PI_F - h_ref_prime;
    if(h_test_prime < 0.f) h_test_prime = DT_2PI_F - h_test_prime;

    // Convert to degrees, again to comply with specs
    h_ref_prime = rad2degf(h_ref_prime);
    h_test_prime = rad2degf(h_test_prime);

    float Dh_prime = h_test_prime - h_ref_prime;
    float Dh_prime_abs = fabsf(Dh_prime);
    if(C_test_prime == 0.f || C_ref_prime == 0.f)
      Dh_prime = 0.f;
    else if(Dh_prime_abs <= 180.f)
      ;
    else if(Dh_prime_abs > 180.f && (h_test_prime <= h_ref_prime))
      Dh_prime += 360.f;
    else if(Dh_prime_abs > 180.f && (h_test_prime > h_ref_prime))
      Dh_prime -= 360.f;

    // update abs(Dh_prime) for later
    Dh_prime_abs = fabsf(Dh_prime);

    const float DH_prime =
      2.f * sqrtf(C_test_prime * C_ref_prime) * sinf(deg2radf(Dh_prime) / 2.f);

    float H_avg_prime = h_ref_prime + h_test_prime;
    if(C_test_prime == 0.f || C_ref_prime == 0.f)
      ;
    else if(Dh_prime_abs <= 180.f)
      H_avg_prime /= 2.f;
    else if(Dh_prime_abs > 180.f && (H_avg_prime < 360.f))
      H_avg_prime = (H_avg_prime + 360.f) / 2.f;
    else if(Dh_prime_abs > 180.f && (H_avg_prime >= 360.f))
      H_avg_prime = (H_avg_prime - 360.f) / 2.f;

    const float T = 1.f
                    - 0.17f * cosf(deg2radf(H_avg_prime - 30))
                    + 0.24f * cosf(2.f * deg2radf(H_avg_prime))
                    + 0.32f * cosf(3.f * deg2radf(H_avg_prime) + deg2radf(6.f))
                    - 0.20f * cosf(4.f * deg2radf(H_avg_prime) - deg2radf(63.f));

    const float S_L = 1.f + (0.015f * sqf(L_avg - 50.f)) / sqrtf(20.f + sqf(L_avg - 50.f));
    const float S_C = 1.f + 0.045f * C_avg_prime;
    const float S_H = 1.f + 0.015f * C_avg_prime * T;
    const float R_T = -2.f * C_avg_7_ratio_sqrt
                      * sinf(deg2radf(60.f) * expf(-sqf((H_avg_prime - 275.f) / 25.f)));

    // roll the drum, here goes the Delta E, finally…
    const float DE = sqrtf(sqf(DL / S_L) + sqf(DC_prime / S_C) + sqf(DH_prime / S_H)
                           + R_T * (DC_prime / S_C) * (DH_prime / S_H));

    // Delta E 1976 for reference :
    //float DE = sqrtf(sqf(Lab_test[0] - Lab_ref[0]) + sqf(Lab_test[1] - Lab_ref[1]) + sqf(Lab_test[2] - Lab_ref[2]));

    //fprintf(stdout, "patch %s : Lab ref \t= \t%.3f \t%.3f \t%.3f \n", checker->values[k].name, Lab_ref[0], Lab_ref[1], Lab_ref[2]);
    //fprintf(stdout, "patch %s : Lab mes \t= \t%.3f \t%.3f \t%.3f \n", checker->values[k].name, Lab_test[0], Lab_test[1], Lab_test[2]);
    //fprintf(stdout, "patch %s : dE mes \t= \t%.3f \n", checker->values[k].name, DE);

    delta_E[k] = DE;
    dE += DE / (float)checker->patches;
    if(DE > max_dE) max_dE = DE;
  }

  *avg_delta_E = dE;
  *max_delta_E = max_dE;
}

#define GET_WEIGHT                                                \
      float hue = atan2f(reference[2], reference[1]);             \
      const float chroma = hypotf(reference[2], reference[1]);    \
      float delta_hue = hue - ref_hue;                            \
      if(chroma == 0.f)                                           \
        delta_hue = 0.f;                                          \
      else if(fabsf(delta_hue) <= M_PI_F)                         \
        ;                                                         \
      else if(fabsf(delta_hue) > M_PI_F && (hue <= ref_hue))      \
        delta_hue += DT_2PI_F;                                \
      else if(fabsf(delta_hue) > M_PI_F && (hue > ref_hue))       \
        delta_hue -= DT_2PI_F;                                \
      w = sqrtf(expf(-sqf(delta_hue) / 2.f));


typedef struct {
  float black;
  float exposure;
} extraction_result_t;

static const extraction_result_t _extract_patches(const float *const restrict in,
                                                  const dt_iop_roi_t *const roi_in,
                                                  checker_fit_t *g,
                                                  const dt_colormatrix_t RGB_to_XYZ,
                                                  const dt_colormatrix_t XYZ_to_CAM,
                                                  float *const restrict patches,
                                                  const gboolean normalize_exposure)
{
  const size_t width = roi_in->width;
  const size_t height = roi_in->height;
  const float radius_x =
    g->checker->radius * hypotf(1.f, g->checker->ratio) * g->safety_margin;
  const float radius_y = radius_x / g->checker->ratio;

  if(g->delta_E_in == NULL)
    g->delta_E_in = dt_alloc_align_float(g->checker->patches);
  if(!g->delta_E_in) return (extraction_result_t){ NAN, NAN };

  /* Get the average color over each patch */
  for(size_t k = 0; k < g->checker->patches; k++)
  {
    // center of the patch in the ideal reference
    const point_t center = { g->checker->values[k].x, g->checker->values[k].y };

    // corners of the patch in the ideal reference
    const point_t corners[4] = { {center.x - radius_x, center.y - radius_y},
                                 {center.x + radius_x, center.y - radius_y},
                                 {center.x + radius_x, center.y + radius_y},
                                 {center.x - radius_x, center.y + radius_y} };

    // apply patch coordinates transform depending on perspective
    point_t new_corners[4];
    // find the bounding box of the patch at the same time
    size_t x_min = width - 1;
    size_t x_max = 0;
    size_t y_min = height - 1;
    size_t y_max = 0;
    for(size_t c = 0; c < 4; c++)
    {
      new_corners[c] = apply_homography(corners[c], g->homography);
      x_min = fminf(CLAMP(new_corners[c].x, 0.f, (float)(width - 1)), x_min);
      x_max = fmaxf(CLAMP(new_corners[c].x, 0.f, (float)(width - 1)), x_max);
      y_min = fminf(CLAMP(new_corners[c].y, 0.f, (float)(height - 1)), y_min);
      y_max = fmaxf(CLAMP(new_corners[c].y, 0.f, (float)(height - 1)), y_max);
    }

    x_min = CLAMP((size_t)floorf(x_min), 0, width - 1);
    x_max = CLAMP((size_t)ceilf(x_max), 0, width - 1);
    y_min = CLAMP((size_t)floorf(y_min), 0, height - 1);
    y_max = CLAMP((size_t)ceilf(y_max), 0, height - 1);

    // Get the average color on the patch
    patches[k * 4] = patches[k * 4 + 1] = patches[k * 4 + 2] = patches[k * 4 + 3] = 0.f;
    size_t num_elem = 0;

    // Loop through the rectangular bounding box
    for(size_t j = y_min; j < y_max; j++)
      for(size_t i = x_min; i < x_max; i++)
      {
        // Check if this pixel lies inside the sampling area and sample if it does
        point_t current_point = { i + 0.5f, j + 0.5f };
        current_point = apply_homography(current_point, g->inverse_homography);
        current_point.x -= center.x;
        current_point.y -= center.y;

        if(current_point.x < radius_x && current_point.x > -radius_x &&
           current_point.y < radius_y && current_point.y > -radius_y)
        {
          for_three_channels(c)
          {
            patches[k * 4 + c] += in[(j * width + i) * 4 + c];

            // Debug : inpaint a black square in the preview to ensure the coordanites of
            // overlay drawings and actual pixel processing match
            // out[(j * width + i) * 4 + c] = 0.f;
          }
          num_elem++;
        }
      }

    if(!num_elem) return (extraction_result_t){ NAN, NAN };
    for_three_channels(c)
      patches[k * 4 + c] /= (float)num_elem;

    // Convert to XYZ
    dt_aligned_pixel_t XYZ = { 0 };
    dot_product(patches + k * 4, RGB_to_XYZ, XYZ);
    for(size_t c = 0; c < 3; c++) patches[k * 4 + c] = XYZ[c];
  }

  // find reference white patch
  dt_aligned_pixel_t XYZ_white_ref;
  dt_Lab_to_XYZ(g->checker->values[g->checker->white].Lab, XYZ_white_ref);
  const float white_ref_norm = euclidean_norm(XYZ_white_ref);

  // find test white patch
  dt_aligned_pixel_t XYZ_white_test;
  for_three_channels(c)
    XYZ_white_test[c] = patches[g->checker->white * 4 + c];
  const float white_test_norm = euclidean_norm(XYZ_white_test);

  /* match global exposure */
  // white exposure depends on camera settings and raw white point,
  // we want our profile to be independent from that
  float exposure = white_ref_norm / white_test_norm;

  /* Exposure compensation */
  // Ensure the relative luminance of the test patch (compared to white patch)
  // is the same as the relative luminance of the reference patch.
  // This compensate for lighting fall-off and unevenness
  if(normalize_exposure)
  {
    for(size_t k = 0; k < g->checker->patches; k++)
    {
      float *const sample = patches + k * 4;

      dt_aligned_pixel_t XYZ_ref;
      dt_Lab_to_XYZ(g->checker->values[k].Lab, XYZ_ref);

      const float sample_norm = euclidean_norm(sample);
      const float ref_norm = euclidean_norm(XYZ_ref);

      const float relative_luminance_test = sample_norm / white_test_norm;
      const float relative_luminance_ref = ref_norm / white_ref_norm;

      const float luma_correction = relative_luminance_ref / relative_luminance_test;
      for_three_channels(c)
        sample[c] *= luma_correction * exposure;
    }
  }

  // black point is evaluated by rawspeed on each picture using the dark pixels
  // we want our profile to be also independent from its discrepancies
  // so we convert back the patches to camera RGB space and search the best fit of
  // RGB_ref = exposure * (RGB_test - offset) for offset.
  float black = 0.f;
  const float user_exposure = exp2f(g->exposure_ev);
  const float user_black = g->black;

  if(XYZ_to_CAM)
  {
    float mean_ref = 0.f;
    float mean_test = 0.f;

    for(size_t k = 0; k < g->checker->patches; k++)
    {
      dt_aligned_pixel_t XYZ_ref, RGB_ref;
      dt_aligned_pixel_t XYZ_test, RGB_test;

      for_three_channels(c)
        XYZ_test[c] = patches[k * 4 + c];
      dt_Lab_to_XYZ(g->checker->values[k].Lab, XYZ_ref);

      dot_product(XYZ_test, XYZ_to_CAM, RGB_test);
      dot_product(XYZ_ref, XYZ_to_CAM, RGB_ref);

      // Undo exposure module settings
      for_three_channels(c)
        RGB_test[c] = RGB_test[c] / user_exposure / exposure + user_black;

      // From now on, we have all the reference and test data in camera RGB space
      // where exposure and black level are applied

      for_three_channels(c)
      {
        mean_test += RGB_test[c];
        mean_ref += RGB_ref[c];
      }
    }
    mean_test /= 3.f * g->checker->patches;
    mean_ref /= 3.f * g->checker->patches;

    float variance = 0.f;
    float covariance = 0.f;

    for(size_t k = 0; k < g->checker->patches; k++)
    {
      dt_aligned_pixel_t XYZ_ref, RGB_ref;
      dt_aligned_pixel_t XYZ_test, RGB_test;

      for_three_channels(c) XYZ_test[c] = patches[k * 4 + c];
      dt_Lab_to_XYZ(g->checker->values[k].Lab, XYZ_ref);

      dot_product(XYZ_test, XYZ_to_CAM, RGB_test);
      dot_product(XYZ_ref, XYZ_to_CAM, RGB_ref);

      // Undo exposure module settings
      for_three_channels(c)
      {
        RGB_test[c] = RGB_test[c] / user_exposure / exposure + user_black;
      }

      for_three_channels(c)
      {
        variance += sqf(RGB_test[c] - mean_test);
        covariance += (RGB_ref[c] - mean_ref) * (RGB_test[c] - mean_ref);
      }
    }
    variance /= 3.f * g->checker->patches;
    covariance /= 3.f * g->checker->patches;

    // Here, we solve the least-squares problem RGB_ref = exposure * RGB_test + offset
    // using :
    //   exposure = covariance(RGB_test, RGB_ref) / variance(RGB_test)
    //   offset = mean(RGB_ref) - exposure * mean(RGB_test)
    exposure = covariance / variance;
    black = mean_ref - exposure * mean_test;
  }

  // the exposure module applies output  = (input - offset) * exposure
  // but we compute output = input * exposure + offset
  // so, rescale offset to adapt our offset to exposure module GUI
  black /= -exposure;

  const extraction_result_t result = { black, exposure };
  return result;
}

static gboolean _valid_extraction(const float *patches, size_t count, extraction_result_t result)
{
  if(!isfinite(result.exposure) || result.exposure <= 0.f || !isfinite(result.black)) return FALSE;
  for(size_t k = 0; k < count * 4; k++)
    if(!isfinite(patches[k])) return FALSE;
  return TRUE;
}

static gboolean _extract_color_checker(const float *const restrict in,
                                   const dt_iop_roi_t *const roi_in,
                                   checker_fit_t *g,
                                   const dt_colormatrix_t RGB_to_XYZ,
                                   const dt_colormatrix_t XYZ_to_CAM,
                                   const dt_adaptation_t kind, float report[9])
{
  float *const restrict patches = dt_alloc_align_float(g->checker->patches * 4);

  if(!patches) return FALSE;

  extraction_result_t extraction_result =
    _extract_patches(in, roi_in, g, RGB_to_XYZ, XYZ_to_CAM,
                     patches, TRUE);

  if(!_valid_extraction(patches, g->checker->patches, extraction_result))
  {
    dt_free_align(patches);
    return FALSE;
  }

  // Compute the delta E
  float pre_wb_delta_E = 0.f;
  float pre_wb_max_delta_E = 0.f;
  _compute_patches_delta_E(patches, g->checker, g->delta_E_in,
                          &pre_wb_delta_E, &pre_wb_max_delta_E);

  /* find the scene illuminant */

  // find reference grey patch
  dt_aligned_pixel_t XYZ_grey_ref = { 0.0f };
  dt_Lab_to_XYZ(g->checker->values[g->checker->middle_grey].Lab, XYZ_grey_ref);

  // find test grey patch
  dt_aligned_pixel_t XYZ_grey_test = { 0.0f };
  for(size_t c = 0; c < 3; c++)
    XYZ_grey_test[c] = patches[g->checker->middle_grey * 4 + c];

  // compute reference illuminant
  dt_aligned_pixel_t D50_XYZ;
  illuminant_xy_to_XYZ(D50xyY.x, D50xyY.y, D50_XYZ);

  // normalize luminances - note : illuminant is normalized by definition
  const float Y_test = MAX(NORM_MIN, XYZ_grey_test[1]);
  const float Y_ref = MAX(NORM_MIN, XYZ_grey_ref[1]);

  dt_vector_div1(XYZ_grey_ref, XYZ_grey_ref, Y_ref);
  dt_vector_div1(XYZ_grey_test, XYZ_grey_test, Y_test);

  // convert XYZ to LMS
  dt_aligned_pixel_t LMS_grey_ref, LMS_grey_test, D50_LMS;
  convert_any_XYZ_to_LMS(XYZ_grey_ref, LMS_grey_ref, kind);
  convert_any_XYZ_to_LMS(XYZ_grey_test, LMS_grey_test, kind);
  convert_any_XYZ_to_LMS(D50_XYZ, D50_LMS, kind);

  // solve the equation to find the scene illuminant
  dt_aligned_pixel_t illuminant = { 0.0f };
  for_three_channels(c)
    illuminant[c] = D50_LMS[c] * LMS_grey_test[c] / LMS_grey_ref[c];

  // convert back the illuminant to XYZ then xyY
  dt_aligned_pixel_t illuminant_XYZ, illuminant_xyY = { .0f };
  convert_any_LMS_to_XYZ(illuminant, illuminant_XYZ, kind);
  dt_vector_clipneg(illuminant_XYZ);
  const float Y_illu = MAX(NORM_MIN, illuminant_XYZ[1]);
  dt_vector_div1(illuminant_XYZ, illuminant_XYZ, Y_illu);
  dt_D50_XYZ_to_xyY(illuminant_XYZ, illuminant_xyY);

  // save the illuminant in GUI struct for commit
  g->colorchecker_xy[0] = illuminant_xyY[0];
  g->colorchecker_xy[1] = illuminant_xyY[1];

  // and recompute back the LMS to be sure we use the parameters that
  // will be computed later
  illuminant_xy_to_XYZ(illuminant_xyY[0], illuminant_xyY[1], illuminant_XYZ);
  convert_any_XYZ_to_LMS(illuminant_XYZ, illuminant, kind);
  const float p = powf(0.818155f / illuminant[2], 0.0834f);

  /* White-balance the patches */
  for(size_t k = 0; k < g->checker->patches; k++)
  {
    // keep in synch with _loop_switch() from process()
    float *const sample = patches + k * 4;
    const float Y = sample[1];
    downscale_vector(sample, Y);

    dt_aligned_pixel_t LMS;
    convert_any_XYZ_to_LMS(sample, LMS, kind);

    dt_aligned_pixel_t temp;

    switch(kind)
    {
      case DT_ADAPTATION_FULL_BRADFORD:
      {
        bradford_adapt_D50(LMS, illuminant, p, TRUE, temp);
        break;
      }
      case DT_ADAPTATION_LINEAR_BRADFORD:
      {
        bradford_adapt_D50(LMS, illuminant, 1.f, FALSE, temp);
        break;
      }
      case DT_ADAPTATION_CAT16:
      {
        CAT16_adapt_D50(LMS, illuminant, 1.f, TRUE, temp); // force full-adaptation
        break;
      }
      case DT_ADAPTATION_XYZ:
      {
        XYZ_adapt_D50(LMS, illuminant, temp);
        break;
      }
      case DT_ADAPTATION_RGB:
      case DT_ADAPTATION_LAST:
      default:
      {
        // No white balance.
        for(size_t c = 0; c < 3; ++c) temp[c] = LMS[c];
        break;
      }
    }

    convert_any_LMS_to_XYZ(temp, sample, kind);
    upscale_vector(sample, Y);
  }

  // Compute the delta E
  float post_wb_delta_E = 0.f;
  float post_wb_max_delta_E = 0.f;
  _compute_patches_delta_E(patches, g->checker, g->delta_E_in,
                          &post_wb_delta_E, &post_wb_max_delta_E);

  /* Compute the matrix of mix */
  double *const restrict Y = dt_alloc_align_double(g->checker->patches * 3);
  double *const restrict A = dt_alloc_align_double(g->checker->patches * 3 * 9);

  if(!Y || !A)
  {
    if(Y) dt_free_align(Y);
    if(A) dt_free_align(A);
    dt_free_align(patches);
    return FALSE;
  }

  gboolean finite = TRUE;
  for(size_t k = 0; k < g->checker->patches; k++)
  {
    float *const sample = patches + k * 4;
    dt_aligned_pixel_t LMS_test;
    convert_any_XYZ_to_LMS(sample, LMS_test, kind);

    float *const reference = g->checker->values[k].Lab;
    dt_aligned_pixel_t XYZ_ref, LMS_ref;
    dt_Lab_to_XYZ(reference, XYZ_ref);
    convert_any_XYZ_to_LMS(XYZ_ref, LMS_ref, kind);

    // get the optimization weights
    double w = 1.0;
    if(g->optimization == DT_SOLVE_OPTIMIZE_NONE)
      w = sqrtf(1.f / (float)g->checker->patches);
    else if(g->optimization == DT_SOLVE_OPTIMIZE_HIGH_SAT)
      w = sqrtf(hypotf(reference[1] / 128.f, reference[2] / 128.f));
    else if(g->optimization == DT_SOLVE_OPTIMIZE_LOW_SAT)
      w = sqrtf(1.f - hypotf(reference[1] / 128.f, reference[2] / 128.f));
    else if(g->optimization == DT_SOLVE_OPTIMIZE_SKIN)
    {
      // average skin hue angle is 1.0 rad, hue range is [0.75 ; 1.25]
      const float ref_hue = 1.f;
      GET_WEIGHT;
    }
    else if(g->optimization == DT_SOLVE_OPTIMIZE_FOLIAGE)
    {
      // average foliage hue angle is 2.23 rad, hue range is [1.94 ; 2.44]
      const float ref_hue = 2.23f;
      GET_WEIGHT;
    }
    else if(g->optimization == DT_SOLVE_OPTIMIZE_SKY)
    {
      // average sky/water hue angle is -1.93 rad, hue range is [-1.64 ; -2.41]
      const float ref_hue = -1.93f;
      GET_WEIGHT;
    }
    else if(g->optimization == DT_SOLVE_OPTIMIZE_AVG_DELTA_E)
      w = sqrtf(sqrtf(1.f / g->delta_E_in[k]));
    else if(g->optimization == DT_SOLVE_OPTIMIZE_MAX_DELTA_E)
      w = sqrtf(sqrtf(g->delta_E_in[k]));

    finite = isfinite(w);
    for(size_t c = 0; c < 3; c++)
      finite &= isfinite(LMS_ref[c]) && isfinite(LMS_test[c]);
    if(!finite) break;

    // fill 3 rows of the y column vector
    for(size_t c = 0; c < 3; c++) Y[k * 3 + c] = w * LMS_ref[c];

    // fill line one of the A matrix
    A[k * 3 * 9 + 0] = w * LMS_test[0];
    A[k * 3 * 9 + 1] = w * LMS_test[1];
    A[k * 3 * 9 + 2] = w * LMS_test[2];
    A[k * 3 * 9 + 3] = 0.f;
    A[k * 3 * 9 + 4] = 0.f;
    A[k * 3 * 9 + 5] = 0.f;
    A[k * 3 * 9 + 6] = 0.f;
    A[k * 3 * 9 + 7] = 0.f;
    A[k * 3 * 9 + 8] = 0.f;

    // fill line two of the A matrix
    A[k * 3 * 9 + 9 + 0] = 0.f;
    A[k * 3 * 9 + 9 + 1] = 0.f;
    A[k * 3 * 9 + 9 + 2] = 0.f;
    A[k * 3 * 9 + 9 + 3] = w * LMS_test[0];
    A[k * 3 * 9 + 9 + 4] = w * LMS_test[1];
    A[k * 3 * 9 + 9 + 5] = w * LMS_test[2];
    A[k * 3 * 9 + 9 + 6] = 0.f;
    A[k * 3 * 9 + 9 + 7] = 0.f;
    A[k * 3 * 9 + 9 + 8] = 0.f;

    // fill line three of the A matrix
    A[k * 3 * 9 + 18 + 0] = 0.f;
    A[k * 3 * 9 + 18 + 1] = 0.f;
    A[k * 3 * 9 + 18 + 2] = 0.f;
    A[k * 3 * 9 + 18 + 3] = 0.f;
    A[k * 3 * 9 + 18 + 4] = 0.f;
    A[k * 3 * 9 + 18 + 5] = 0.f;
    A[k * 3 * 9 + 18 + 6] = w * LMS_test[0];
    A[k * 3 * 9 + 18 + 7] = w * LMS_test[1];
    A[k * 3 * 9 + 18 + 8] = w * LMS_test[2];
  }

  const gboolean solved = finite && pseudo_solve_gaussian(A, Y, g->checker->patches * 3, 9, TRUE);
  if(!solved)
  {
    dt_free_align(Y);
    dt_free_align(A);
    dt_free_align(patches);
    return FALSE;
  }

  // repack the matrix
  repack_double3x3_to_3xSSE(Y, g->mix);

  dt_free_align(Y);
  dt_free_align(A);

  // apply the matrix mix
  for(size_t k = 0; k < g->checker->patches; k++)
  {
    float *const sample = patches + k * 4;
    dt_aligned_pixel_t LMS_test;
    dt_aligned_pixel_t temp = { 0.f };

    // Restore the original exposure of the patch
    for(size_t c = 0; c < 3; c++) temp[c] = sample[c];

    convert_any_XYZ_to_LMS(temp, LMS_test, kind);
      dot_product(LMS_test, g->mix, temp);
    convert_any_LMS_to_XYZ(temp, sample, kind);
  }

  // Compute the delta E
  float post_mix_delta_E = 0.f;
  float post_mix_max_delta_E = 0.f;
  _compute_patches_delta_E(patches, g->checker, g->delta_E_in,
                          &post_mix_delta_E, &post_mix_max_delta_E);

  // get the temperature
  float temperature;
  dt_illuminant_t test_illuminant;
  float x = illuminant_xyY[0];
  float y = illuminant_xyY[1];
  _check_if_close_to_daylight(x, y, &temperature, &test_illuminant, NULL);
  const float values[] = { post_mix_delta_E, post_mix_max_delta_E,
    pre_wb_delta_E, pre_wb_max_delta_E, post_wb_delta_E, post_wb_max_delta_E,
    log2f(extraction_result.exposure), extraction_result.black, temperature };
  memcpy(report, values, sizeof values);
  dt_free_align(patches);
  return TRUE;
}

static gboolean _validate_color_checker(const _working_t *w, checker_fit_t *g,
                                        const dt_colormatrix_t rgb_to_xyz,
                                        const float (*xyz_to_cam)[4], float report[9])
{
  float *patches = dt_alloc_align_float(4 * g->checker->patches);
  if(!patches) return FALSE;
  const extraction_result_t result = _extract_patches(w->data, &w->roi, g, rgb_to_xyz,
                                                       xyz_to_cam, patches, FALSE);
  const gboolean valid = _valid_extraction(patches, g->checker->patches, result);
  if(valid)
  {
    _compute_patches_delta_E(patches, g->checker, g->delta_E_in, report, report + 1);
    report[6] = log2f(result.exposure);
    report[7] = result.black;
  }
  dt_free_align(patches);
  return valid;
}

static gboolean _convex_box(const point_t box[4])
{
  float first = 0.f;
  for(int k = 0; k < 4; k++)
  {
    const point_t a = box[k], b = box[(k + 1) % 4], c = box[(k + 2) % 4];
    const float cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if(!isfinite(cross) || cross == 0.f) return FALSE;
    if(k == 0) first = cross;
    else if((cross < 0.f) != (first < 0.f)) return FALSE;
  }
  return TRUE;
}

gboolean checker_analyze(JsonObject *req, JsonBuilder *b, char **err)
{
  const int chart = json_object_get_int_member_with_default(req, "chart", 0);
  if(chart < 0 || chart >= COLOR_CHECKER_LAST)
  {
    *err = g_strdup("unknown color checker chart");
    return FALSE;
  }
  checker_fit_t g = { .checker = dt_get_color_checker(chart) };
  if(json_object_get_boolean_member_with_default(req, "layout", FALSE))
  {
    engine_add_double(b, "radius", g.checker->radius * hypot(1.0, g.checker->ratio));
    engine_add_double(b, "ratio", g.checker->ratio);
    json_builder_set_member_name(b, "centers");
    json_builder_begin_array(b);
    for(size_t k = 0; k < g.checker->patches; k++)
    {
      json_builder_add_double_value(b, g.checker->values[k].x);
      json_builder_add_double_value(b, g.checker->values[k].y);
    }
    json_builder_end_array(b);
    return TRUE;
  }

  JsonNode *photo = json_object_get_member(req, "imgid");
  if(photo && JSON_NODE_HOLDS_VALUE(photo) && json_node_get_int(photo) != _s.imgid)
  {
    *err = g_strdup("the color checker photo is no longer open");
    return FALSE;
  }

  const int priority = json_object_get_int_member_with_default(req, "priority", 0);
  const int optimization = json_object_get_int_member_with_default(req, "optimization", 0);
  const double scale = json_object_get_double_member_with_default(req, "scale", 0.5);
  const gboolean validate = json_object_get_boolean_member_with_default(req, "validate", FALSE);
  JsonNode *node = json_object_get_member(req, "box");
  JsonArray *array = node && JSON_NODE_HOLDS_ARRAY(node) ? json_node_get_array(node) : NULL;
  if(!array || json_array_get_length(array) != 8 || optimization < DT_SOLVE_OPTIMIZE_NONE
     || optimization > DT_SOLVE_OPTIMIZE_MAX_DELTA_E || !(scale > 0.0 && scale <= 1.0))
  {
    *err = g_strdup("invalid color checker settings");
    return FALSE;
  }
  g.optimization = optimization;
  g.safety_margin = scale;

  float points[8];
  for(int k = 0; k < 8; k++)
  {
    const double v = json_array_get_double_element(array, k);
    if(!(v >= 0.0 && v <= 1.0))
    {
      *err = g_strdup("color checker corners must be inside the image");
      return FALSE;
    }
    points[k] = v;
  }
  dt_iop_module_t *mod = session_module_at("channelmixerrgb", priority, err);
  if(!mod) return FALSE;
  if(validate && !mod->enabled)
  {
    *err = g_strdup("enable color calibration before validating");
    return FALSE;
  }

  dt_introspection_field_t *field = NULL;
  const int *adaptation = session_field_in(mod, mod->params, "adaptation", &field, err);
  const int *illuminant = adaptation ? session_field_in(mod, mod->params, "illuminant", &field, err) : NULL;
  if(!illuminant) return FALSE;
  const dt_adaptation_t kind = (*illuminant == DT_ILLUMINANT_CAMERA || *illuminant == DT_ILLUMINANT_FROM_WB)
    ? DT_ADAPTATION_CAT16 : *adaptation;

  // The exposure GUI proxy is absent in the engine. Read the same fields
  // from the enabled base instance for the normalization report.
  dt_iop_module_t *exposure = dt_iop_get_module_by_op_priority(_s.dev.iop, "exposure", 0);
  if(exposure && exposure->enabled)
  {
    const int *mode = session_field_in(exposure, exposure->params, "mode", &field, err);
    const float *ev = mode ? session_field_in(exposure, exposure->params,
      *mode == 1 ? "deflicker_target_level" : "exposure", &field, err) : NULL;
    const float *black = ev ? session_field_in(exposure, exposure->params, "black", &field, err) : NULL;
    if(!black) return FALSE;
    g.exposure_ev = *ev;
    g.black = *black;
  }

  _working_t w = { 0 };
  if(!masks_working_checker(&w, mod, validate, err)) return FALSE;
  masks_to_working(&w, points, 4);
  const point_t box[4] = { {points[0], points[1]}, {points[2], points[3]},
                           {points[4], points[5]}, {points[6], points[7]} };
  const point_t ideal[4] = { {0, 0}, {1, 0}, {1, 1}, {0, 1} };
  if(!_convex_box(box) || !get_homography(ideal, box, g.homography)
     || !get_homography(box, ideal, g.inverse_homography))
  {
    *err = g_strdup("invalid color checker corners");
    return FALSE;
  }

  const dt_iop_order_iccprofile_info_t *work = dt_ioppr_get_pipe_current_profile_info(mod, &_s.ppipe);
  const dt_iop_order_iccprofile_info_t *input = dt_ioppr_get_pipe_input_profile_info(&_s.ppipe);
  if(!work)
  {
    *err = g_strdup("no working profile for color checker");
    return FALSE;
  }

  dt_colormatrix_t rgb_to_xyz, xyz_to_cam;
  memcpy(rgb_to_xyz, work->matrix_in, sizeof rgb_to_xyz);
  if(input) memcpy(xyz_to_cam, input->matrix_out, sizeof xyz_to_cam);
  float report[9] = { 0 };
  const gboolean success = validate
    ? _validate_color_checker(&w, &g, rgb_to_xyz, input ? xyz_to_cam : NULL, report)
    : _extract_color_checker(w.data, &w.roi, &g, rgb_to_xyz, input ? xyz_to_cam : NULL, kind, report);
  if(g.delta_E_in) dt_free_align(g.delta_E_in);
  gboolean finite = success;
  for(size_t k = 0; k < G_N_ELEMENTS(report); k++) finite &= isfinite(report[k]);
  if(!validate)
  {
    finite &= isfinite(g.colorchecker_xy[0]) && isfinite(g.colorchecker_xy[1]) && g.colorchecker_xy[1] > 0.f;
    for(int row = 0; row < 3; row++)
      for(int col = 0; col < 3; col++) finite &= isfinite(g.mix[row][col]);
  }
  if(!finite)
  {
    *err = g_strdup("could not measure all color checker patches");
    return FALSE;
  }

  json_builder_set_member_name(b, "report");
  json_builder_begin_array(b);
  for(size_t k = 0; k < G_N_ELEMENTS(report); k++) json_builder_add_double_value(b, report[k]);
  json_builder_end_array(b);
  if(!validate)
  {
    json_builder_set_member_name(b, "fields");
    json_builder_begin_object(b);
    engine_add_double(b, "x", g.colorchecker_xy[0]);
    engine_add_double(b, "y", g.colorchecker_xy[1]);
    engine_add_int(b, "illuminant", DT_ILLUMINANT_CUSTOM);
    engine_add_double(b, "temperature", report[8]);
    engine_add_int(b, "adaptation", kind);
    const char *channels[] = { "red", "green", "blue" };
    for(int row = 0; row < 3; row++)
      for(int col = 0; col < 3; col++)
      {
        char path[16];
        g_snprintf(path, sizeof path, "%s[%d]", channels[row], col);
        engine_add_double(b, path, g.mix[row][col]);
      }
    json_builder_end_object(b);
  }
  return TRUE;
}
