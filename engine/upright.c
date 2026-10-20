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

// ashift's structure detection and fit, which darktable runs only from its
// GUI: they read the module's gui_data, and the image they work on is kept
// only by a GUI preview pipe. darktable's source is left as it is, so the
// GUI-free parts are copied here unchanged from src/iop/ashift.c at
// 69498129cd (constants, line types, _homography, line_detect and its
// enhancements, ransac, model_fitness), with LSD and the simplex included
// as ashift.c includes them. _remove_outliers and nmsfit are rewritten
// below to take the lines instead of gui_data. compare these with
// ashift.c when taking a new darktable release

#include "upright.h"

#include "common/bilateral.h"
#include "common/colorspaces_inline_conversions.h"
#include "common/darktable.h"
#include "common/math.h"
#include "common/matrices.h"

#include <assert.h>
#include <float.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

// ------------------------------------------- copied from src/iop/ashift.c

#define ROTATION_RANGE 10                   // allowed min/max default range for rotation parameter
#define ROTATION_RANGE_SOFT 180             // allowed min/max range for rotation parameter with manual adjustment
#define LENSSHIFT_RANGE 1.0                 // allowed min/max default range for lensshift parameters
#define LENSSHIFT_RANGE_SOFT 2.0            // allowed min/max range for lensshift parameters with manual adjustment
#define SHEAR_RANGE 0.2                     // allowed min/max range for shear parameter
#define SHEAR_RANGE_SOFT 0.5                // allowed min/max range for shear parameter with manual adjustment
#define MIN_LINE_LENGTH 5                   // the minimum length of a line in pixels to be regarded as relevant
#define MAX_TANGENTIAL_DEVIATION 30         // by how many degrees a line may deviate from the +/-180 and +/-90 to be regarded as relevant
#define LSD_SCALE 0.99                      // LSD: scaling factor for line detection
#define LSD_SIGMA_SCALE 0.6                 // LSD: sigma for Gaussian filter is computed as sigma = sigma_scale/scale
#define LSD_QUANT 2.0                       // LSD: bound to the quantization error on the gradient norm
#define LSD_ANG_TH 22.5                     // LSD: gradient angle tolerance in degrees
#define LSD_LOG_EPS 0.0                     // LSD: detection threshold: -log10(NFA) > log_eps
#define LSD_DENSITY_TH 0.7                  // LSD: minimal density of region points in rectangle
#define LSD_N_BINS 1024                     // LSD: number of bins in pseudo-ordering of gradient modulus
#define LSD_GAMMA 0.45                      // gamma correction to apply on raw images prior to line detection
#define RANSAC_RUNS 400                     // how many iterations to run in ransac
#define RANSAC_EPSILON 2                    // starting value for ransac epsilon (in -log10 units)
#define RANSAC_EPSILON_STEP 1               // step size of epsilon optimization (log10 units)
#define RANSAC_ELIMINATION_RATIO 60         // percentage of lines we try to eliminate as outliers
#define RANSAC_OPTIMIZATION_STEPS 5         // home many steps to optimize epsilon
#define RANSAC_OPTIMIZATION_DRY_RUNS 50     // how man runs per optimization steps
#define RANSAC_HURDLE 5                     // hurdle rate: the number of lines below which we do a complete permutation instead of random sampling
#define MINIMUM_FITLINES 2                  // minimum number of lines needed for automatic parameter fit
#define NMS_EPSILON 1e-3                    // break criterion for Nelder-Mead simplex
#define NMS_SCALE 1.0                       // scaling factor for Nelder-Mead simplex
#define NMS_ITERATIONS 400                  // number of iterations for Nelder-Mead simplex
#define NMS_CROP_EPSILON 100.0              // break criterion for Nelder-Mead simplex on crop fitting
#define NMS_CROP_SCALE 0.5                  // scaling factor for Nelder-Mead simplex on crop fitting
#define NMS_CROP_ITERATIONS 100             // number of iterations for Nelder-Mead simplex on crop fitting
#define NMS_ALPHA 1.0                       // reflection coefficient for Nelder-Mead simplex
#define NMS_BETA 0.5                        // contraction coefficient for Nelder-Mead simplex
#define NMS_GAMMA 2.0                       // expansion coefficient for Nelder-Mead simplex
#define DEFAULT_F_LENGTH 28.0               // focal length we assume if no exif data are available

#include "iop/ashift_lsd.c"
#include "iop/ashift_nmsimplex.c"


typedef enum dt_iop_ashift_homodir_t
{
  ASHIFT_HOMOGRAPH_FORWARD,
  ASHIFT_HOMOGRAPH_INVERTED
} dt_iop_ashift_homodir_t;

typedef enum dt_iop_ashift_linetype_t
{
  ASHIFT_LINE_IRRELEVANT   = 0,       // the line is found to be not interesting
                                      // eg. too short, or not horizontal or vertical
  ASHIFT_LINE_RELEVANT     = 1 << 0,  // the line is relevant for us
  ASHIFT_LINE_DIRVERT      = 1 << 1,  // the line is (mostly) vertical, else (mostly) horizontal
  ASHIFT_LINE_SELECTED     = 1 << 2,  // the line is selected for fitting
  ASHIFT_LINE_VERTICAL_NOT_SELECTED   = ASHIFT_LINE_RELEVANT | ASHIFT_LINE_DIRVERT,
  ASHIFT_LINE_HORIZONTAL_NOT_SELECTED = ASHIFT_LINE_RELEVANT,
  ASHIFT_LINE_VERTICAL_SELECTED = ASHIFT_LINE_RELEVANT | ASHIFT_LINE_DIRVERT | ASHIFT_LINE_SELECTED,
  ASHIFT_LINE_HORIZONTAL_SELECTED = ASHIFT_LINE_RELEVANT | ASHIFT_LINE_SELECTED,
  ASHIFT_LINE_MASK = ASHIFT_LINE_RELEVANT | ASHIFT_LINE_DIRVERT | ASHIFT_LINE_SELECTED
} dt_iop_ashift_linetype_t;
typedef enum dt_iop_ashift_fitaxis_t
{
  ASHIFT_FIT_NONE          = 0,       // none
  ASHIFT_FIT_ROTATION      = 1 << 0,  // flag indicates to fit rotation angle
  ASHIFT_FIT_LENS_VERT     = 1 << 1,  // flag indicates to fit vertical lens shift
  ASHIFT_FIT_LENS_HOR      = 1 << 2,  // flag indicates to fit horizontal lens shift
  ASHIFT_FIT_SHEAR         = 1 << 3,  // flag indicates to fit shear parameter
  ASHIFT_FIT_LINES_VERT    = 1 << 4,  // use vertical lines for fitting
  ASHIFT_FIT_LINES_HOR     = 1 << 5,  // use horizontal lines for fitting
  ASHIFT_FIT_LENS_BOTH = ASHIFT_FIT_LENS_VERT | ASHIFT_FIT_LENS_HOR,
  ASHIFT_FIT_LINES_BOTH = ASHIFT_FIT_LINES_VERT | ASHIFT_FIT_LINES_HOR,
  ASHIFT_FIT_VERTICALLY = ASHIFT_FIT_ROTATION | ASHIFT_FIT_LENS_VERT | ASHIFT_FIT_LINES_VERT,
  ASHIFT_FIT_HORIZONTALLY = ASHIFT_FIT_ROTATION | ASHIFT_FIT_LENS_HOR | ASHIFT_FIT_LINES_HOR,
  ASHIFT_FIT_BOTH = ASHIFT_FIT_ROTATION | ASHIFT_FIT_LENS_VERT | ASHIFT_FIT_LENS_HOR |
                    ASHIFT_FIT_LINES_VERT | ASHIFT_FIT_LINES_HOR,
  ASHIFT_FIT_VERTICALLY_NO_ROTATION = ASHIFT_FIT_LENS_VERT | ASHIFT_FIT_LINES_VERT,
  ASHIFT_FIT_HORIZONTALLY_NO_ROTATION = ASHIFT_FIT_LENS_HOR | ASHIFT_FIT_LINES_HOR,
  ASHIFT_FIT_BOTH_NO_ROTATION = ASHIFT_FIT_LENS_VERT | ASHIFT_FIT_LENS_HOR |
                                ASHIFT_FIT_LINES_VERT | ASHIFT_FIT_LINES_HOR,
  ASHIFT_FIT_BOTH_SHEAR = ASHIFT_FIT_ROTATION | ASHIFT_FIT_LENS_VERT | ASHIFT_FIT_LENS_HOR |
                    ASHIFT_FIT_SHEAR | ASHIFT_FIT_LINES_VERT | ASHIFT_FIT_LINES_HOR,
  ASHIFT_FIT_ROTATION_VERTICAL_LINES = ASHIFT_FIT_ROTATION | ASHIFT_FIT_LINES_VERT,
  ASHIFT_FIT_ROTATION_HORIZONTAL_LINES = ASHIFT_FIT_ROTATION | ASHIFT_FIT_LINES_HOR,
  ASHIFT_FIT_ROTATION_BOTH_LINES = ASHIFT_FIT_ROTATION | ASHIFT_FIT_LINES_VERT | ASHIFT_FIT_LINES_HOR,
  ASHIFT_FIT_FLIP = ASHIFT_FIT_LENS_VERT | ASHIFT_FIT_LENS_HOR | ASHIFT_FIT_LINES_VERT | ASHIFT_FIT_LINES_HOR
} dt_iop_ashift_fitaxis_t;

typedef enum dt_iop_ashift_nmsresult_t
{
  NMS_SUCCESS = 0,
  NMS_NOT_ENOUGH_LINES = 1,
  NMS_DID_NOT_CONVERGE = 2,
  NMS_INSANE = 3
} dt_iop_ashift_nmsresult_t;

typedef enum dt_iop_ashift_enhance_t
{
  ASHIFT_ENHANCE_NONE       = 0,
  ASHIFT_ENHANCE_EDGES      = 1 << 0,
  ASHIFT_ENHANCE_DETAIL     = 1 << 1,
  ASHIFT_ENHANCE_HORIZONTAL = 0x100,
  ASHIFT_ENHANCE_VERTICAL   = 0x200
} dt_iop_ashift_enhance_t;

typedef struct dt_iop_ashift_line_t
{
  float p1[3];
  float p2[3];
  float length;
  float width;
  float weight;
  dt_iop_ashift_linetype_t type;
  // homogeneous coordinates:
  float DT_ALIGNED_PIXEL L[3];
} dt_iop_ashift_line_t;


typedef struct dt_iop_ashift_fit_params_t
{
  int params_count;
  dt_iop_ashift_linetype_t linetype;
  dt_iop_ashift_linetype_t linemask;
  dt_iop_ashift_line_t *lines;
  int lines_count;
  int width;
  int height;
  float weight;
  float f_length_kb;
  float orthocorr;
  float aspect;
  float rotation;
  float lensshift_v;
  float lensshift_h;
  float shear;
  float rotation_range;
  float lensshift_v_range;
  float lensshift_h_range;
  float shear_range;
} dt_iop_ashift_fit_params_t;


// normalized product of two 3x1 vectors
// dst needs to be different from v1 and v2
static inline void vec3prodn(float *dst, const float *const v1, const float *const v2)
{
  const float l1 = v1[1] * v2[2] - v1[2] * v2[1];
  const float l2 = v1[2] * v2[0] - v1[0] * v2[2];
  const float l3 = v1[0] * v2[1] - v1[1] * v2[0];

  // normalize so that l1^2 + l2^2 + l3^3 = 1
  const float sq = sqrtf(l1 * l1 + l2 * l2 + l3 * l3);

  const float f = sq > 0.0f ? 1.0f / sq : 1.0f;

  dst[0] = l1 * f;
  dst[1] = l2 * f;
  dst[2] = l3 * f;
}

// normalize a 3x1 vector so that x^2 + y^2 + z^2 = 1
// dst and v may be the same
static inline void vec3norm(float *dst, const float *const v)
{
  const float sq = sqrtf(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);

  // special handling for an all-zero vector
  const float f = sq > 0.0f ? 1.0f / sq : 1.0f;

  dst[0] = v[0] * f;
  dst[1] = v[1] * f;
  dst[2] = v[2] * f;
}

// normalize a 3x1 vector so that x^2 + y^2 = 1; a useful normalization for
// lines in homogeneous coordinates
// dst and v may be the same
static inline void vec3lnorm(float *dst, const float *const v)
{
  const float sq = dt_fast_hypotf(v[0], v[1]);

  // special handling for a point vector of the image center
  const float f = sq > 0.0f ? 1.0f / sq : 1.0f;

  dst[0] = v[0] * f;
  dst[1] = v[1] * f;
  dst[2] = v[2] * f;
}


// scalar product of two 3x1 vectors
static inline float vec3scalar(const float *const v1, const float *const v2)
{
  return (v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]);
}

// check if 3x1 vector is (very close to) null
static inline int vec3isnull(const float *const v)
{
  const float eps = 1e-10f;
  return (fabsf(v[0]) < eps && fabsf(v[1]) < eps && fabsf(v[2]) < eps);
}

#define MAT3SWAP(a, b) { float (*tmp)[3] = (a); (a) = (b); (b) = tmp; }

static void _homography(float *homograph,
                        const float angle,
                        const float shift_v,
                        const float shift_h,
                        const float shear,
                        const float f_length_kb,
                        const float orthocorr,
                        const float aspect,
                        const int width,
                        const int height,
                        const dt_iop_ashift_homodir_t dir)
{
  // calculate homograph that combines all translations, rotations
  // and warping into one single matrix operation.
  // this is heavily leaning on ShiftN where the homographic matrix expects
  // input in (y : x : 1) format. in the darktable world we want to keep the
  // (x : y : 1) convention. therefore we need to flip coordinates first and
  // make sure that output is in correct format after corrections are applied.

  const float u = width;
  const float v = height;

  const float phi = deg2radf(angle);
  const float cosi = cosf(phi);
  const float sini = sinf(phi);
  const float ascale = sqrtf(aspect);

  // most of this comes from ShiftN
  const float f_global = f_length_kb;
  const float horifac = 1.0f - orthocorr / 100.0f;
  const float exppa_v = expf(shift_v);
  const float fdb_v = f_global / (14.4f + (v / u - 1) * 7.2f);
  const float rad_v = fdb_v * (exppa_v - 1.0f) / (exppa_v + 1.0f);
  const float alpha_v = CLAMP(atanf(rad_v), -1.5f, 1.5f);
  const float rt_v = sinf(0.5f * alpha_v);
  const float r_v = fmaxf(0.1f, 2.0f * (horifac - 1.0f) * rt_v * rt_v + 1.0f);

  const float vertifac = 1.0f - orthocorr / 100.0f;
  const float exppa_h = expf(shift_h);
  const float fdb_h = f_global / (14.4f + (u / v - 1) * 7.2f);
  const float rad_h = fdb_h * (exppa_h - 1.0f) / (exppa_h + 1.0f);
  const float alpha_h = CLAMP(atanf(rad_h), -1.5f, 1.5f);
  const float rt_h = sinf(0.5f * alpha_h);
  const float r_h = fmaxf(0.1f, 2.0f * (vertifac - 1.0f) * rt_h * rt_h + 1.0f);


  // three intermediate buffers for matrix calculation ...
  float DT_ALIGNED_ARRAY m1[3][3];
  float DT_ALIGNED_ARRAY m2[3][3];
  float DT_ALIGNED_ARRAY m3[3][3];

  // ... and some pointers to handle them more intuitively
  float (*mwork)[3] = m1;
  float (*minput)[3] = m2;
  float (*moutput)[3] = m3;

  // Step 1: flip x and y coordinates (see above)
  memset(minput, 0, sizeof(float) * 9);
  minput[0][1] = 1.0f;
  minput[1][0] = 1.0f;
  minput[2][2] = 1.0f;


  // Step 2: rotation of image around its center
  memset(mwork, 0, sizeof(float) * 9);
  mwork[0][0] = cosi;
  mwork[0][1] = -sini;
  mwork[1][0] = sini;
  mwork[1][1] = cosi;
  mwork[0][2] = -0.5f * v * cosi + 0.5f * u * sini + 0.5f * v;
  mwork[1][2] = -0.5f * v * sini - 0.5f * u * cosi + 0.5f * u;
  mwork[2][2] = 1.0f;

  // multiply mwork * minput -> moutput
  mat3mul((float *)moutput, (float *)mwork, (float *)minput);


  // Step 3: apply shearing
  memset(mwork, 0, sizeof(float) * 9);
  mwork[0][0] = 1.0f;
  mwork[0][1] = shear;
  mwork[1][1] = 1.0f;
  mwork[1][0] = shear;
  mwork[2][2] = 1.0f;

  // moutput (of last calculation) -> minput
  MAT3SWAP(minput, moutput);
  // multiply mwork * minput -> moutput
  mat3mul((float *)moutput, (float *)mwork, (float *)minput);


  // Step 4: apply vertical lens shift effect
  memset(mwork, 0, sizeof(float) * 9);
  mwork[0][0] = exppa_v;
  mwork[1][0] = 0.5f * ((exppa_v - 1.0f) * u) / v;
  mwork[1][1] = 2.0f * exppa_v / (exppa_v + 1.0f);
  mwork[1][2] = -0.5f * ((exppa_v - 1.0f) * u) / (exppa_v + 1.0f);
  mwork[2][0] = (exppa_v - 1.0f) / v;
  mwork[2][2] = 1.0f;

  // moutput (of last calculation) -> minput
  MAT3SWAP(minput, moutput);
  // multiply mwork * minput -> moutput
  mat3mul((float *)moutput, (float *)mwork, (float *)minput);


  // Step 5: horizontal compression
  memset(mwork, 0, sizeof(float) * 9);
  mwork[0][0] = 1.0f;
  mwork[1][1] = r_v;
  mwork[1][2] = 0.5f * u * (1.0f - r_v);
  mwork[2][2] = 1.0f;

  // moutput (of last calculation) -> minput
  MAT3SWAP(minput, moutput);
  // multiply mwork * minput -> moutput
  mat3mul((float *)moutput, (float *)mwork, (float *)minput);


  // Step 6: flip x and y back again
  memset(mwork, 0, sizeof(float) * 9);
  mwork[0][1] = 1.0f;
  mwork[1][0] = 1.0f;
  mwork[2][2] = 1.0f;

  // moutput (of last calculation) -> minput
  MAT3SWAP(minput, moutput);
  // multiply mwork * minput -> moutput
  mat3mul((float *)moutput, (float *)mwork, (float *)minput);


  // from here output vectors would be in (x : y : 1) format

  // Step 7: now we can apply horizontal lens shift with the same matrix format as above
  memset(mwork, 0, sizeof(float) * 9);
  mwork[0][0] = exppa_h;
  mwork[1][0] = 0.5f * ((exppa_h - 1.0f) * v) / u;
  mwork[1][1] = 2.0f * exppa_h / (exppa_h + 1.0f);
  mwork[1][2] = -0.5f * ((exppa_h - 1.0f) * v) / (exppa_h + 1.0f);
  mwork[2][0] = (exppa_h - 1.0f) / u;
  mwork[2][2] = 1.0f;

  // moutput (of last calculation) -> minput
  MAT3SWAP(minput, moutput);
  // multiply mwork * minput -> moutput
  mat3mul((float *)moutput, (float *)mwork, (float *)minput);


  // Step 8: vertical compression
  memset(mwork, 0, sizeof(float) * 9);
  mwork[0][0] = 1.0f;
  mwork[1][1] = r_h;
  mwork[1][2] = 0.5f * v * (1.0f - r_h);
  mwork[2][2] = 1.0f;

  // moutput (of last calculation) -> minput
  MAT3SWAP(minput, moutput);
  // multiply mwork * minput -> moutput
  mat3mul((float *)moutput, (float *)mwork, (float *)minput);


  // Step 9: apply aspect ratio scaling
  memset(mwork, 0, sizeof(float) * 9);
  mwork[0][0] = 1.0f * ascale;
  mwork[1][1] = 1.0f / ascale;
  mwork[2][2] = 1.0f;

  // moutput (of last calculation) -> minput
  MAT3SWAP(minput, moutput);
  // multiply mwork * minput -> moutput
  mat3mul((float *)moutput, (float *)mwork, (float *)minput);


  // Step 10: find x/y offsets and apply according correction so that
  // no negative coordinates occur in output vector
  float umin = FLT_MAX, vmin = FLT_MAX;
  // visit all four corners
  for(int y = 0; y < height; y += height - 1)
    for(int x = 0; x < width; x += width - 1)
    {
      float pi[3], po[3];
      pi[0] = x;
      pi[1] = y;
      pi[2] = 1.0f;
      // moutput expects input in (x:y:1) format and gives output as (x:y:1)
      mat3mulv(po, (float *)moutput, pi);
      umin = MIN(umin, po[0] / po[2]);
      vmin = MIN(vmin, po[1] / po[2]);
    }

  memset(mwork, 0, sizeof(float) * 9);
  mwork[0][0] = 1.0f;
  mwork[1][1] = 1.0f;
  mwork[2][2] = 1.0f;
  mwork[0][2] = -umin;
  mwork[1][2] = -vmin;

  // moutput (of last calculation) -> minput
  MAT3SWAP(minput, moutput);
  // multiply mwork * minput -> moutput
  mat3mul((float *)moutput, (float *)mwork, (float *)minput);


  // on request we either keep the final matrix for forward conversions
  // or produce an inverted matrix for backward conversions
  if(dir == ASHIFT_HOMOGRAPH_FORWARD)
  {
    // we have what we need -> copy it to the right place
    memcpy(homograph, moutput, sizeof(float) * 9);
  }
  else
  {
    // generate inverted homograph (mat3inv function defined in colorspaces.c)
    if(mat3inv((float *)homograph, (float *)moutput))
    {
      // in case of error we set to unity matrix
      memset(mwork, 0, sizeof(float) * 9);
      mwork[0][0] = 1.0f;
      mwork[1][1] = 1.0f;
      mwork[2][2] = 1.0f;
      memcpy(homograph, mwork, sizeof(float) * 9);
    }
  }
}
#undef MAT3SWAP

// simple conversion of rgb image into greyscale variant suitable for
// line segment detection the lsd routines expect input as *double,
// roughly in the range [0.0; 256.0]
static void rgb2grey256(const float *const in,
                        double *const out,
                        const int width,
                        const int height)
{
  const size_t npixels = (size_t)width * height;

  DT_OMP_FOR()
  for(size_t index = 0; index < npixels; index++)
  {
    out[index] = (0.3f * in[4*index+0]
                  + 0.59f * in[4*index+1]
                  + 0.11f * in[4*index+2]) * 256.0;
  }
}

// sobel edge enhancement in one direction
static void edge_enhance_1d(const double *in, double *out,
                            const int width,
                            const int height,
                            const dt_iop_ashift_enhance_t dir)
{
  // Sobel kernels for both directions
  const double hkernel[3][3] = { { 1.0, 0.0, -1.0 },
                                 { 2.0, 0.0, -2.0 },
                                 { 1.0, 0.0, -1.0 } };

  const double vkernel[3][3] = { { 1.0, 2.0, 1.0 },
                                 { 0.0, 0.0, 0.0 },
                                 { -1.0, -2.0, -1.0 } };
  const int kwidth = 3;
  const int khwidth = kwidth / 2;

  // select kernel
  const double *kernel = (dir == ASHIFT_ENHANCE_HORIZONTAL)
    ? (const double *)hkernel
    : (const double *)vkernel;

  DT_OMP_FOR()
  // loop over image pixels and perform sobel convolution
  for(int j = khwidth; j < height - khwidth; j++)
  {
    const double *inp = in + (size_t)j * width + khwidth;
    double *outp = out + (size_t)j * width + khwidth;
    for(int i = khwidth; i < width - khwidth; i++, inp++, outp++)
    {
      double sum = 0.0f;
      for(int jj = 0; jj < kwidth; jj++)
      {
        const int k = jj * kwidth;
        const int l = (jj - khwidth) * width;
        for(int ii = 0; ii < kwidth; ii++)
        {
          sum += inp[l + ii - khwidth] * kernel[k + ii];
        }
      }
      *outp = sum;
    }
  }

  DT_OMP_FOR()
  // border fill in output buffer, so we don't get pseudo lines at image frame
  for(int j = 0; j < height; j++)
    for(int i = 0; i < width; i++)
    {
      double val = out[(size_t)j * width + i];

      if(j < khwidth)
        val = out[(size_t)(khwidth - j) * width + i];
      else if(j >= height - khwidth)
        val = out[(size_t)(j - khwidth) * width + i];
      else if(i < khwidth)
        val = out[(size_t)j * width + (khwidth - i)];
      else if(i >= width - khwidth)
        val = out[(size_t)j * width + (i - khwidth)];

      out[(size_t)j * width + i] = val;

      // jump over center of image
      if(i == khwidth && j >= khwidth && j < height - khwidth) i = width - khwidth;
    }
}

// edge enhancement in both directions
static gboolean edge_enhance(const double *in,
                        double *out,
                        const int width,
                        const int height)
{
  double *Gx = NULL;
  double *Gy = NULL;

  Gx = malloc(sizeof(double) * width * height);
  if(Gx == NULL) goto error;

  Gy = malloc(sizeof(double) * width * height);
  if(Gy == NULL) goto error;

  // perform edge enhancement in both directions
  edge_enhance_1d(in, Gx, width, height, ASHIFT_ENHANCE_HORIZONTAL);
  edge_enhance_1d(in, Gy, width, height, ASHIFT_ENHANCE_VERTICAL);

// calculate absolute values
  DT_OMP_FOR()
  for(size_t k = 0; k < (size_t)width * height; k++)
  {
    out[k] = sqrt(Gx[k] * Gx[k] + Gy[k] * Gy[k]);
  }

  free(Gx);
  free(Gy);
  return TRUE;

error:
  if(Gx) free(Gx);
  if(Gy) free(Gy);
  return FALSE;
}

// detail enhancement via bilateral grid (function arguments in and
// out may represent identical buffers)
static gboolean detail_enhance(const float *const in,
                          float *const out,
                          const int width,
                          const int height)
{
  const float sigma_r = 5.0f;
  const float sigma_s = fminf(width, height) * 0.02f;
  const float detail = 10.0f;
  const size_t npixels = (size_t)width * height;
  gboolean success = TRUE;

  // we need to convert from RGB to Lab first;
  // as colors don't matter we are safe to assume data to be sRGB

  // convert RGB input to Lab, use output buffer for intermediate storage
  DT_OMP_FOR()
  for(size_t index = 0; index < 4*npixels; index += 4)
  {
    dt_aligned_pixel_t XYZ;
    dt_Rec709_to_XYZ_D50(in + index, XYZ);  // convert linear sRBG to XYZ
    dt_XYZ_to_Lab(XYZ, out + index);
  }

  // bilateral grid detail enhancement
  dt_bilateral_t *b = dt_bilateral_init(width, height, sigma_s, sigma_r);

  if(b != NULL)
  {
    dt_bilateral_splat(b, out);
    dt_bilateral_blur(b);
    dt_bilateral_slice_to_output(b, out, out, detail);
    dt_bilateral_free(b);
  }
  else
    success = FALSE;

  // convert resulting Lab to RGB output
  DT_OMP_FOR()
  for(size_t index = 0; index < 4*npixels; index += 4)
  {
    dt_aligned_pixel_t XYZ;
    dt_Lab_to_XYZ(out + index, XYZ);
    dt_XYZ_to_linearRGB(XYZ, out + index);
  }

  return success;
}

// apply gamma correction to RGB buffer (function arguments in and out
// may represent identical buffers)
static void gamma_correct(const float *const in,
                          float *const out,
                          const int width,
                          const int height)
{
  const size_t npixels = (size_t)width * height;
  DT_OMP_FOR()
  for(size_t index = 0; index < 4 * npixels; index += 4)
  {
    for_three_channels(c)
      out[index+c] = powf(in[index+c], LSD_GAMMA);
  }
}

// do actual line_detection based on LSD algorithm and return results according
// to this module's conventions
static gboolean line_detect(float *in,
                       const int width,
                       const int height,
                       const int x_off,
                       const int y_off,
                       const float scale,
                       dt_iop_ashift_line_t **alines,
                       int *lcount,
                       int *vcount,
                       int *hcount,
                       float *vweight,
                       float *hweight,
                       const dt_iop_ashift_enhance_t enhance,
                       const gboolean is_raw)
{
  double *greyscale = NULL;
  double *lsd_lines = NULL;
  dt_iop_ashift_line_t *ashift_lines = NULL;

  int vertical_count = 0;
  int horizontal_count = 0;
  float vertical_weight = 0.0f;
  float horizontal_weight = 0.0f;

  // apply gamma correction if image is raw
  if(is_raw)
  {
    gamma_correct(in, in, width, height);
  }

  // if requested perform an additional detail enhancement step
  if(enhance & ASHIFT_ENHANCE_DETAIL)
  {
    (void)detail_enhance(in, in, width, height);
  }

  // allocate intermediate buffers
  greyscale = malloc(sizeof(double) * width * height);
  if(greyscale == NULL) goto error;

  // convert to greyscale image
  rgb2grey256(in, greyscale, width, height);

  // if requested perform an additional edge enhancement step
  if(enhance & ASHIFT_ENHANCE_EDGES)
  {
    (void)edge_enhance(greyscale, greyscale, width, height);
  }

  // call the line segment detector LSD;
  // LSD stores the number of found lines in lines_count.
  // it returns structural details as vector 'double lines[7 * lines_count]'
  int lines_count;

  lsd_lines = LineSegmentDetection(&lines_count, greyscale, width, height,
                                   LSD_SCALE, LSD_SIGMA_SCALE, LSD_QUANT,
                                   LSD_ANG_TH, LSD_LOG_EPS, LSD_DENSITY_TH,
                                   LSD_N_BINS, NULL, NULL, NULL);

  // we count the lines that we really want to use
  int lct = 0;
  if(lines_count > 0)
  {
    // aggregate lines data into our own structures
    ashift_lines = malloc(sizeof(dt_iop_ashift_line_t) * lines_count);

    if(ashift_lines == NULL) goto error;

    for(int n = 0; n < lines_count; n++)
    {
      const float x1 = lsd_lines[n * 7 + 0];
      const float y1 = lsd_lines[n * 7 + 1];
      const float x2 = lsd_lines[n * 7 + 2];
      const float y2 = lsd_lines[n * 7 + 3];

      // check for lines running along image borders and skip them.
      // these would likely be false-positives which could result
      // from any kind of processing artifacts
      if((fabsf(x1 - x2) < 1 && fmaxf(x1, x2) < 2)
         || (fabsf(x1 - x2) < 1 && fminf(x1, x2) > width - 3)
         || (fabsf(y1 - y2) < 1 && fmaxf(y1, y2) < 2)
         || (fabsf(y1 - y2) < 1 && fminf(y1, y2) > height - 3))
        continue;

      // line position in absolute coordinates
      float px1 = x_off + x1;
      float py1 = y_off + y1;
      float px2 = x_off + x2;
      float py2 = y_off + y2;

      // scale back to input buffer
      px1 /= scale;
      py1 /= scale;
      px2 /= scale;
      py2 /= scale;

      // store as homogeneous coordinates
      ashift_lines[lct].p1[0] = px1;
      ashift_lines[lct].p1[1] = py1;
      ashift_lines[lct].p1[2] = 1.0f;
      ashift_lines[lct].p2[0] = px2;
      ashift_lines[lct].p2[1] = py2;
      ashift_lines[lct].p2[2] = 1.0f;

      // calculate homogeneous coordinates of connecting line (defined by the two points)
      vec3prodn(ashift_lines[lct].L, ashift_lines[lct].p1, ashift_lines[lct].p2);

      // normalaze line coordinates so that x^2 + y^2 = 1
      // (this will always succeed as L is a real line connecting two real points)
      vec3lnorm(ashift_lines[lct].L, ashift_lines[lct].L);

      // length and width of rectangle (see LSD)
      ashift_lines[lct].length = sqrt((px2 - px1) * (px2 - px1)
                                      + (py2 - py1) * (py2 - py1));
      ashift_lines[lct].width = lsd_lines[n * 7 + 4] / scale;

      // ...  and weight (= length * width * angle precision)
      const float weight = ashift_lines[lct].length
                             * ashift_lines[lct].width
                             * lsd_lines[n * 7 + 5];

      ashift_lines[lct].weight = weight;


      const float angle = rad2degf(atan2f(py2 - py1, px2 - px1));
      const gboolean vertical = fabsf(fabsf(angle) - 90.0f) < MAX_TANGENTIAL_DEVIATION;
      const gboolean horizontal = fabsf(fabsf(fabsf(angle) - 90.0f) - 90.0f) < MAX_TANGENTIAL_DEVIATION;
      const gboolean relevant = ashift_lines[lct].length > MIN_LINE_LENGTH;

      // register type of line
      dt_iop_ashift_linetype_t type = ASHIFT_LINE_IRRELEVANT;

      if(vertical && relevant)
      {
        type = ASHIFT_LINE_VERTICAL_SELECTED;
        vertical_count++;
        vertical_weight += weight;
      }
      else if(horizontal && relevant)
      {
        type = ASHIFT_LINE_HORIZONTAL_SELECTED;
        horizontal_count++;
        horizontal_weight += weight;
      }
      ashift_lines[lct].type = type;

      // the next valid line
      lct++;
    }
  }
#ifdef ASHIFT_DEBUG
    printf("%d lines (vertical %d, horizontal %d, not relevant %d)\n",
           lines_count, vertical_count,
           horizontal_count, lct - vertical_count - horizontal_count);
    float xmin = FLT_MAX, xmax = FLT_MIN, ymin = FLT_MAX, ymax = FLT_MIN;
    for(int n = 0; n < lct; n++)
    {
      xmin = fmin(xmin, fmin(ashift_lines[n].p1[0], ashift_lines[n].p2[0]));
      xmax = fmax(xmax, fmax(ashift_lines[n].p1[0], ashift_lines[n].p2[0]));
      ymin = fmin(ymin, fmin(ashift_lines[n].p1[1], ashift_lines[n].p2[1]));
      ymax = fmax(ymax, fmax(ashift_lines[n].p1[1], ashift_lines[n].p2[1]));
      printf("x1 %.0f, y1 %.0f, x2 %.0f, y2 %.0f,"
             " length %.0f, width %f, X %f, Y %f, Z %f, type %d, scalars %f %f\n",
             ashift_lines[n].p1[0], ashift_lines[n].p1[1], ashift_lines[n].p2[0],
             ashift_lines[n].p2[1],
             ashift_lines[n].length, ashift_lines[n].width,
             ashift_lines[n].L[0], ashift_lines[n].L[1], ashift_lines[n].L[2],
             ashift_lines[n].type,
             vec3scalar(ashift_lines[n].p1, ashift_lines[n].L),
             vec3scalar(ashift_lines[n].p2, ashift_lines[n].L));
    }
    printf("xmin %.0f, xmax %.0f, ymin %.0f, ymax %.0f\n", xmin, xmax, ymin, ymax);
#endif

  // store results in provided locations
  *lcount = lct;
  *vcount = vertical_count;
  *vweight = vertical_weight;
  *hcount = horizontal_count;
  *hweight = horizontal_weight;
  *alines = ashift_lines;

  // free intermediate buffers
  free(lsd_lines);
  free(greyscale);
  return lct > 0;

error:
  free(lsd_lines);
  free(greyscale);
  return FALSE;
}


// swap two integer values
static inline void swap(int *a, int *b)
{
  const int tmp = *a;
  *a = *b;
  *b = tmp;
}

// do complete permutations
static gboolean quickperm(int *a, int *p, const int N, int *i)
{
  if(*i >= N) return FALSE;

  p[*i]--;
  const int j = (*i % 2 == 1) ? p[*i] : 0;
  swap(&a[j], &a[*i]);
  *i = 1;
  while(p[*i] == 0)
  {
    p[*i] = *i;
    (*i)++;
  }
  return TRUE;
}

// Fisher-Yates shuffle
static void shuffle(int *a, const int N)
{
  for(int i = 0; i < N; i++)
  {
    const int j = i + rand() % (N - i);
    swap(&a[j], &a[i]);
  }
}

// factorial function
static int fact(const int n)
{
  return (n == 1 ? 1 : n * fact(n - 1));
}

// We use a pseudo-RANSAC algorithm to elminiate ouliers from our set of lines. The
// original RANSAC works on linear optimization problems. Our model is nonlinear. We
// take advantage of the fact that lines interesting for our model are vantage lines
// that meet in one vantage point for each subset of lines (vertical/horizontal).
// Strategy: we construct a model by (random) sampling within the subset of lines and
// calculate the vantage point. Then we check the "distance" of all other lines to the
// vantage point. The model that gives highest number of lines combined with the highest
// total weight and lowest overall "distance" wins.
// Disadvantage: compared to the original RANSAC we don't get any model parameters that
// we could use for the following NMS fit.
//
// Self-tuning: we optimize "epsilon", the hurdle rate to reject a
// line as an outlier, by a number of dry runs first. The target
// average percentage value of lines to eliminate as outliers (without
// judging on the quality of the model) is given by
// RANSAC_ELIMINATION_RATIO,
//
// note: the actual percentage of outliers removed in the final run
// will be lower because we will finally look for the best quality
// model with the optimized epsilon and that quality value also
// encloses the number of good lines.

static void ransac(const dt_iop_ashift_line_t *lines,
                   int *index_set,
                   int *inout_set,
                   const int set_count,
                   const float total_weight,
                   const int xmin,
                   const int xmax,
                   const int ymin,
                   const int ymax)
{
  if(set_count < 3) return;

  const size_t set_size = set_count * sizeof(int);
  int *best_set = malloc(set_size);
  memcpy(best_set, index_set, set_size);
  int *best_inout = calloc(1, set_size);

  float best_quality = 0.0f;

  // hurdle value epsilon for rejecting a line as an outlier will be self-tuning
  // in a number of dry runs
  float epsilon = powf(10.0f, -RANSAC_EPSILON);
  float epsilon_step = RANSAC_EPSILON_STEP;
  // some accounting variables for self-tuning
  int lines_eliminated = 0;
  int valid_runs = 0;

  // number of runs to optimize epsilon
  const int optiruns = RANSAC_OPTIMIZATION_STEPS * RANSAC_OPTIMIZATION_DRY_RUNS;
  // go for complete permutations on small set sizes, else for random sample consensus
  const int riter = (set_count > RANSAC_HURDLE) ? RANSAC_RUNS : fact(set_count);

  // some data needed for quickperm
  int *perm = malloc(sizeof(int) * (set_count + 1));
  for(int n = 0; n < set_count + 1; n++) perm[n] = n;
  int piter = 1;

  // inout holds good/bad qualification for each line
  int *inout = malloc(set_size);

  for(int r = 0; r < optiruns + riter; r++)
  {
    // get random or systematic variation of index set
    if(set_count > RANSAC_HURDLE || r < optiruns)
      shuffle(index_set, set_count);
    else
      (void)quickperm(index_set, perm, set_count, &piter);

    // summed quality evaluation of this run
    float quality = 0.0f;

    // we build a model ouf of the first two lines
    const float *L1 = lines[index_set[0]].L;
    const float *L2 = lines[index_set[1]].L;

    // get intersection point (ideally a vantage point)
    float DT_ALIGNED_PIXEL V[3];
    vec3prodn(V, L1, L2);

    // catch special cases:
    // a) L1 and L2 are identical -> V is NULL -> no valid vantage point
    // b) vantage point lies inside image frame (no chance to correct for this case)
    if(vec3isnull(V) ||
       (fabsf(V[2]) > 0.0f &&
        V[0]/V[2] >= xmin &&
        V[1]/V[2] >= ymin &&
        V[0]/V[2] <= xmax &&
        V[1]/V[2] <= ymax))
    {
      // no valid model
      quality = 0.0f;
    }
    else
    {
      // valid model

      // normalize V so that x^2 + y^2 + z^2 = 1
      vec3norm(V, V);

      // the two lines constituting the model are part of the set
      inout[0] = 1;
      inout[1] = 1;

      // go through all remaining lines, check if they are within the model, and
      // mark that fact in inout[].
      // summarize a quality parameter for all lines within the model
      for(int n = 2; n < set_count; n++)
      {
        // L is normalized so that x^2 + y^2 = 1
        const float *L3 = lines[index_set[n]].L;

        // we take the absolute value of the dot product of V and L as
        // a measure of the "distance" between point and line. Note
        // that this is not the real euclidean distance but - with the
        // given normalization - just a pragmatically selected number
        // that goes to zero if V lies on L and increases the more V
        // and L are apart
        const float d = fabsf(vec3scalar(V, L3));

        // depending on d we either include or exclude the point from the set
        inout[n] = (d < epsilon) ? 1 : 0;

        float q;

        if(inout[n] == 1)
        {
          // a quality parameter that depends 1/3 on the number of
          // lines within the model, 1/3 on their weight, and 1/3 on
          // their weighted distance d to the vantage point
          q = 0.33f / (float)set_count
              + 0.33f * lines[index_set[n]].weight / total_weight
              + 0.33f * (1.0f - d / epsilon)
                         * (float)set_count * lines[index_set[n]].weight / total_weight;
        }
        else
        {
          q = 0.0f;
          lines_eliminated++;
        }

        quality += q;
      }
      valid_runs++;
    }

    if(r < optiruns)
    {
      // on last run of each self-tuning step
      if((r % RANSAC_OPTIMIZATION_DRY_RUNS) == (RANSAC_OPTIMIZATION_DRY_RUNS - 1)
         && (valid_runs > 0))
      {
#ifdef ASHIFT_DEBUG
        printf("ransac self-tuning (run %d): epsilon %f", r, epsilon);
#endif
        // average ratio of lines that we eliminated with the given epsilon
        float ratio = 100.0f * (float)lines_eliminated / ((float)set_count * valid_runs);
        // adjust epsilon accordingly
        if(ratio < RANSAC_ELIMINATION_RATIO)
          epsilon = powf(10.0f, log10(epsilon) - epsilon_step);
        else if(ratio > RANSAC_ELIMINATION_RATIO)
          epsilon = powf(10.0f, log10(epsilon) + epsilon_step);
#ifdef ASHIFT_DEBUG
        printf(" (elimination ratio %f) -> %f\n", ratio, epsilon);
#endif
        // reduce step-size for next optimization round
        epsilon_step /= 2.0f;
        lines_eliminated = 0;
        valid_runs = 0;
      }
    }
    else
    {
      // in the "real" runs check against the best model found so far
      if(quality > best_quality)
      {
        memcpy(best_set, index_set, set_size);
        memcpy(best_inout, inout, set_size);
        best_quality = quality;
      }
    }

#ifdef ASHIFT_DEBUG
    // report some statistics
    int count = 0, lastcount = 0;
    for(int n = 0; n < set_count; n++) count += best_inout[n];
    for(int n = 0; n < set_count; n++) lastcount += inout[n];
    printf("ransac run %d: best qual %.6f, eps %.6f,"
           " line count %d of %d (this run: qual %.5f, count %d (%2f%%))\n", r,
           best_quality, epsilon, count, set_count, quality, lastcount,
           100.0f * lastcount / (float)set_count);
#endif
  }

  // store back best set
  memcpy(index_set, best_set, set_size);
  memcpy(inout_set, best_inout, set_size);

  free(inout);
  free(perm);
  free(best_inout);
  free(best_set);
}


// utility function to map a variable in [min; max] to [-INF; + INF]
static inline double logit(const double x, const double min, const double max)
{
  const double eps = 1.0e-6;
  // make sure p does not touch the borders of its definition area,
  // not critical for data accuracy as logit() is only used on initial fit parameters
  const double p = CLAMP((x - min) / (max - min), eps, 1.0 - eps);

  return (2.0 * atanh(2.0 * p - 1.0));
}

// inverted function to logit()
static inline double ilogit(const double L, const double min, const double max)
{
  const double p = 0.5 * (1.0 + tanh(0.5 * L));

  return (p * (max - min) + min);
}

// helper function for simplex() return quality parameter for the given model
// strategy:
//    * generate homography matrix out of fixed parameters and fitting parameters
//    * apply homography to all end points of affected lines
//    * generate new line out of transformed end points
//    * calculate scalar product s of line with perpendicular axis
//    * sum over weighted s^2 values

static double model_fitness(double *params, void *data)
{
  const dt_iop_ashift_fit_params_t *fit = (dt_iop_ashift_fit_params_t *)data;

  // just for convenience: get shorter names
  const dt_iop_ashift_line_t *lines = fit->lines;
  const int lines_count = fit->lines_count;
  const int width = fit->width;
  const int height = fit->height;
  const float f_length_kb = fit->f_length_kb;
  const float orthocorr = fit->orthocorr;
  const float aspect = fit->aspect;

  float rotation = fit->rotation;
  float lensshift_v = fit->lensshift_v;
  float lensshift_h = fit->lensshift_h;
  float shear = fit->shear;
  const float rotation_range = fit->rotation_range;
  const float lensshift_v_range = fit->lensshift_v_range;
  const float lensshift_h_range = fit->lensshift_h_range;
  const float shear_range = fit->shear_range;

  int pcount = 0;

  // fill in fit parameters from params[]. Attention: order matters!!!
  if(dt_isnan(rotation))
  {
    rotation = ilogit(params[pcount], -rotation_range, rotation_range);
    pcount++;
  }

  if(dt_isnan(lensshift_v))
  {
    lensshift_v = ilogit(params[pcount], -lensshift_v_range, lensshift_v_range);
    pcount++;
  }

  if(dt_isnan(lensshift_h))
  {
    lensshift_h = ilogit(params[pcount], -lensshift_h_range, lensshift_h_range);
    pcount++;
  }

  if(dt_isnan(shear))
  {
    shear = ilogit(params[pcount], -shear_range, shear_range);
    pcount++;
  }

  assert(pcount == fit->params_count);

  // the possible reference axes
  const float DT_ALIGNED_PIXEL Av[3] = { 1.0f, 0.0f, 0.0f };
  const float DT_ALIGNED_PIXEL Ah[3] = { 0.0f, 1.0f, 0.0f };

  // generate homograph out of the parameters
  float DT_ALIGNED_ARRAY homograph[3][3];
  _homography((float *)homograph, rotation, lensshift_v, lensshift_h, shear, f_length_kb,
              orthocorr, aspect, width, height, ASHIFT_HOMOGRAPH_FORWARD);

  // accounting variables
  double sumsq_v = 0.0;
  double sumsq_h = 0.0;
  double weight_v = 0.0;
  double weight_h = 0.0;
  int count_v = 0;
  int count_h = 0;
  int count = 0;

  // iterate over all lines
  for(int n = 0; n < lines_count; n++)
  {
    // check if this is a line which we must skip
    if((lines[n].type & fit->linemask) != fit->linetype)
      continue;

    // the direction of this line (vertical?)
    const int isvertical = lines[n].type & ASHIFT_LINE_DIRVERT;

    // select the perpendicular reference axis
    const float *A = isvertical ? Ah : Av;

    // apply homographic transformation to the end points
    float DT_ALIGNED_PIXEL P1[3];
    float DT_ALIGNED_PIXEL P2[3];
    mat3mulv(P1, (float *)homograph, lines[n].p1);
    mat3mulv(P2, (float *)homograph, lines[n].p2);

    // get line connecting the two points
    float DT_ALIGNED_PIXEL L[3];
    vec3prodn(L, P1, P2);

    // normalize L so that x^2 + y^2 = 1; makes sure that
    // y^2 = 1 / (1 + m^2) and x^2 = m^2 / (1 + m^2) with m defining the slope of the line
    vec3lnorm(L, L);

    // get scalar product of line L with orthogonal axis A -> gives 0
    // if line is perpendicular
    const float s = vec3scalar(L, A);

    // sum up weighted s^2 for both directions individually
    sumsq_v += isvertical ? s * s * lines[n].weight : 0.0;
    weight_v  += isvertical ? lines[n].weight : 0.0;
    count_v += isvertical ? 1 : 0;
    sumsq_h += !isvertical ? s * s * lines[n].weight : 0.0;
    weight_h  += !isvertical ? lines[n].weight : 0.0;
    count_h += !isvertical ? 1 : 0;
    count++;
  }

  const double v = weight_v > 0.0f && count > 0
    ? sumsq_v / weight_v * (float)count_v / count
    : 0.0;

  const double h = weight_h > 0.0f && count > 0
    ? sumsq_h / weight_h * (float)count_h / count
    : 0.0;

  double sum = sqrt(1.0 - (1.0 - v) * (1.0 - h)) * 1.0e6;
  //double sum = sqrt(v + h) * 1.0e6;

#ifdef ASHIFT_DEBUG
  printf("fitness with rotation %f, lensshift_v %f,"
         " lensshift_h %f, shear %f -> lines %d, quality %10f\n",
         rotation, lensshift_v, lensshift_h, shear, count, sum);
#endif

  return sum;
}

// ------------------------------------------------------------ Immage's own

struct upright_lines_t
{
  dt_iop_ashift_line_t *lines;
  int count;
  int vertical_count;
  int horizontal_count;
  float vertical_weight;
  float horizontal_weight;
};

// _remove_outliers() on a set of lines. ransac rejects vantage points
// inside the frame, which is given here in the lines' own unscaled pixels
static gboolean _remove_outliers(upright_lines_t *l, const int xmin, const int xmax,
                                 const int ymin, const int ymax)
{
  if(l->count < 1) return TRUE;
  int *lines_set = malloc(sizeof(int) * l->count);
  int *inout_set = malloc(sizeof(int) * l->count);
  if(!lines_set || !inout_set)
  {
    free(inout_set);
    free(lines_set);
    return FALSE;
  }

  for(int dir = 0; dir < 2; dir++)
  {
    const dt_iop_ashift_linetype_t want = dir ? ASHIFT_LINE_HORIZONTAL_SELECTED
                                              : ASHIFT_LINE_VERTICAL_SELECTED;
    int nb = 0, count = 0;
    for(int n = 0; n < l->count; n++)
    {
      if((l->lines[n].type & ASHIFT_LINE_MASK) != want) continue;
      lines_set[nb] = n;
      inout_set[nb] = 0;
      nb++;
    }
    // it only makes sense to call ransac if we have more than two lines
    if(nb > 2)
      ransac(l->lines, lines_set, inout_set, nb, dir ? l->horizontal_weight : l->vertical_weight,
             xmin, xmax, ymin, ymax);
    for(int n = 0; n < nb; n++)
    {
      const int m = lines_set[n];
      if(inout_set[n] == 1)
      {
        l->lines[m].type |= ASHIFT_LINE_SELECTED;
        count++;
      }
      else
        l->lines[m].type &= ~ASHIFT_LINE_SELECTED;
    }
    if(dir) l->horizontal_count = count;
    else l->vertical_count = count;
  }

  free(inout_set);
  free(lines_set);
  return TRUE;
}

upright_lines_t *upright_detect(float *in, const int width, const int height, const int x_off,
                                const int y_off, const float scale, const gboolean is_raw)
{
  upright_lines_t *l = calloc(1, sizeof(upright_lines_t));
  if(!l) return NULL;
  if(!line_detect(in, width, height, x_off, y_off, scale, &l->lines, &l->count,
                  &l->vertical_count, &l->horizontal_count, &l->vertical_weight,
                  &l->horizontal_weight, ASHIFT_ENHANCE_NONE, is_raw)
     || !_remove_outliers(l, x_off / scale, (x_off + width) / scale,
                          y_off / scale, (y_off + height) / scale))
  {
    upright_lines_free(l);
    return NULL;
  }
  return l;
}

// as _draw_basic_line() and _draw_retrieve_lines_from_params() in ashift.c:
// each drawn line weighs the same
upright_lines_t *upright_drawn(const float *pts, const int count)
{
  if(count < 1) return NULL;
  upright_lines_t *l = calloc(1, sizeof(upright_lines_t));
  if(!l) return NULL;
  l->lines = calloc(count, sizeof(dt_iop_ashift_line_t));
  if(!l->lines)
  {
    free(l);
    return NULL;
  }
  for(int i = 0; i < count; i++)
  {
    const float *p = pts + 4 * i;
    dt_iop_ashift_line_t *line = &l->lines[i];
    const gboolean horizontal = fabsf(p[0] - p[2]) > fabsf(p[1] - p[3]);
    line->p1[0] = p[0];
    line->p1[1] = p[1];
    line->p1[2] = 1.0f;
    line->p2[0] = p[2];
    line->p2[1] = p[3];
    line->p2[2] = 1.0f;
    vec3prodn(line->L, line->p1, line->p2);
    vec3lnorm(line->L, line->L);
    line->length = hypotf(p[2] - p[0], p[3] - p[1]);
    line->width = 1.0f;
    line->weight = 1.0f;
    line->type = horizontal ? ASHIFT_LINE_HORIZONTAL_SELECTED : ASHIFT_LINE_VERTICAL_SELECTED;
    if(horizontal) l->horizontal_count++;
    else l->vertical_count++;
  }
  l->count = count;
  l->vertical_weight = l->vertical_count;
  l->horizontal_weight = l->horizontal_count;
  return l;
}

void upright_lines_free(upright_lines_t *l)
{
  if(!l) return;
  free(l->lines);
  free(l);
}

void upright_lines_counts(const upright_lines_t *l, int *vertical, int *horizontal,
                          float *vweight, float *hweight)
{
  *vertical = l ? l->vertical_count : 0;
  *horizontal = l ? l->horizontal_count : 0;
  *vweight = l ? l->vertical_weight : 0.0f;
  *hweight = l ? l->horizontal_weight : 0.0f;
}

// nmsfit() from ashift.c, on the given lines, from neutral parameters, with
// the GUI's soft ranges, for the generic lens model ("specific" with 28 mm,
// crop factor 1 and no lens dependence) and the given aspect
upright_result_t upright_fit(const upright_lines_t *l, const upright_fit_t which, const int width,
                             const int height, const gboolean flipped, const float aspect,
                             float *rotation, float *lensshift_v, float *lensshift_h)
{
  if(!l || !l->lines) return UPRIGHT_NOT_ENOUGH_LINES;

  const dt_iop_ashift_fitaxis_t dir = which == UPRIGHT_LEVEL ? ASHIFT_FIT_ROTATION_BOTH_LINES
                                      : which == UPRIGHT_VERTICAL ? ASHIFT_FIT_VERTICALLY
                                      : which == UPRIGHT_HORIZONTAL ? ASHIFT_FIT_HORIZONTALLY
                                      : ASHIFT_FIT_BOTH;
  double params[4];
  int pcount = 0;
  int enough_lines = TRUE;

  dt_iop_ashift_fit_params_t fit;
  fit.lines = l->lines;
  fit.lines_count = l->count;
  fit.width = width;
  fit.height = height;
  fit.f_length_kb = DEFAULT_F_LENGTH;
  fit.orthocorr = 0.0f;
  fit.aspect = aspect;
  fit.rotation = 0.0f;
  fit.lensshift_v = 0.0f;
  fit.lensshift_h = 0.0f;
  fit.shear = 0.0f;
  fit.rotation_range = ROTATION_RANGE_SOFT;
  fit.lensshift_v_range = LENSSHIFT_RANGE_SOFT;
  fit.lensshift_h_range = LENSSHIFT_RANGE_SOFT;
  fit.shear_range = SHEAR_RANGE_SOFT;
  fit.linetype = ASHIFT_LINE_RELEVANT | ASHIFT_LINE_SELECTED;
  fit.linemask = ASHIFT_LINE_MASK;
  fit.params_count = 0;
  fit.weight = 0.0f;

  // if the image is flipped and if we do not want to fit both lens shift
  // directions or none at all, then we need to change direction
  dt_iop_ashift_fitaxis_t mdir = dir;
  if((mdir & ASHIFT_FIT_LENS_BOTH) != ASHIFT_FIT_LENS_BOTH && (mdir & ASHIFT_FIT_LENS_BOTH) != 0)
  {
    mdir ^= flipped ? ASHIFT_FIT_FLIP : 0;
    mdir |= (mdir & ASHIFT_FIT_LINES_BOTH) == 0 ? ASHIFT_FIT_LINES_BOTH : 0;
  }

  // the parameters to fit are marked NAN, in the order model_fitness() reads them
  if(mdir & ASHIFT_FIT_ROTATION)
  {
    fit.params_count++;
    params[pcount++] = logit(fit.rotation, -fit.rotation_range, fit.rotation_range);
    fit.rotation = NAN;
  }
  if(mdir & ASHIFT_FIT_LENS_VERT)
  {
    fit.params_count++;
    params[pcount++] = logit(fit.lensshift_v, -fit.lensshift_v_range, fit.lensshift_v_range);
    fit.lensshift_v = NAN;
  }
  if(mdir & ASHIFT_FIT_LENS_HOR)
  {
    fit.params_count++;
    params[pcount++] = logit(fit.lensshift_h, -fit.lensshift_h_range, fit.lensshift_h_range);
    fit.lensshift_h = NAN;
  }
  if(mdir & ASHIFT_FIT_LINES_VERT)
  {
    fit.linetype |= ASHIFT_LINE_DIRVERT;
    fit.weight += l->vertical_weight;
    enough_lines = enough_lines && (l->vertical_count >= MINIMUM_FITLINES);
  }
  if(mdir & ASHIFT_FIT_LINES_HOR)
  {
    fit.weight += l->horizontal_weight;
    enough_lines = enough_lines && (l->horizontal_count >= MINIMUM_FITLINES);
  }
  if((mdir & ASHIFT_FIT_LINES_BOTH) == ASHIFT_FIT_LINES_BOTH)
  {
    fit.linetype = ASHIFT_LINE_RELEVANT | ASHIFT_LINE_SELECTED;
    fit.linemask = ASHIFT_LINE_RELEVANT | ASHIFT_LINE_SELECTED;
  }
  // levelling needs two lines in all, of either kind, not two of each
  if(which == UPRIGHT_LEVEL)
    enough_lines = l->vertical_count + l->horizontal_count >= MINIMUM_FITLINES;
  if(!enough_lines) return UPRIGHT_NOT_ENOUGH_LINES;

  const int iter = simplex(model_fitness, params, fit.params_count, NMS_EPSILON, NMS_SCALE,
                           NMS_ITERATIONS, NULL, (void *)&fit);
  if(iter >= NMS_ITERATIONS) return UPRIGHT_DID_NOT_CONVERGE;

  pcount = 0;
  fit.rotation = dt_isnan(fit.rotation)
    ? ilogit(params[pcount++], -fit.rotation_range, fit.rotation_range) : fit.rotation;
  fit.lensshift_v = dt_isnan(fit.lensshift_v)
    ? ilogit(params[pcount++], -fit.lensshift_v_range, fit.lensshift_v_range) : fit.lensshift_v;
  fit.lensshift_h = dt_isnan(fit.lensshift_h)
    ? ilogit(params[pcount++], -fit.lensshift_h_range, fit.lensshift_h_range) : fit.lensshift_h;

  // an image grown to more than four times its area is taken as a failed fit
  float DT_ALIGNED_ARRAY homograph[3][3];
  _homography((float *)homograph, fit.rotation, fit.lensshift_v, fit.lensshift_h, fit.shear,
              fit.f_length_kb, fit.orthocorr, fit.aspect, fit.width, fit.height,
              ASHIFT_HOMOGRAPH_FORWARD);
  float xm = FLT_MAX, xM = -FLT_MAX, ym = FLT_MAX, yM = -FLT_MAX;
  for(int y = 0; y < fit.height; y += fit.height - 1)
    for(int x = 0; x < fit.width; x += fit.width - 1)
    {
      float DT_ALIGNED_PIXEL pi[3] = { x, y, 1.0f }, DT_ALIGNED_PIXEL po[3];
      mat3mulv(po, (float *)homograph, pi);
      xm = MIN(xm, po[0] / po[2]);
      ym = MIN(ym, po[1] / po[2]);
      xM = MAX(xM, po[0] / po[2]);
      yM = MAX(yM, po[1] / po[2]);
    }
  if((xM - xm) * (yM - ym) > 4.0f * fit.width * fit.height) return UPRIGHT_INSANE;

  *rotation = fit.rotation;
  *lensshift_v = fit.lensshift_v;
  *lensshift_h = fit.lensshift_h;
  return UPRIGHT_OK;
}
