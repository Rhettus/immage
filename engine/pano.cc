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

// the stitch is OpenCV's cv::detail pipeline, as its
// samples/cpp/stitching_detailed.cpp runs it, kept linear: features, the
// cameras, seams and exposure gains come from small 8-bit copies; the
// full-size frames are warped as floats and scaled by their gains in
// linear. OpenCV's blender takes 16-bit integers only (blenders.cpp,
// CV_16SC3), so the warped frames go to it log-encoded into 15 bits and
// come back decoded

#include "pano.h"

#include <algorithm>
#include <climits>
#include <cmath>
#include <vector>

#include <opencv2/core.hpp>
#include <opencv2/features2d.hpp>
#include <opencv2/imgproc.hpp>
#include <opencv2/stitching/detail/blenders.hpp>
#include <opencv2/stitching/detail/camera.hpp>
#include <opencv2/stitching/detail/exposure_compensate.hpp>
#include <opencv2/stitching/detail/matchers.hpp>
#include <opencv2/stitching/detail/motion_estimators.hpp>
#include <opencv2/stitching/detail/seam_finders.hpp>
#include <opencv2/stitching/detail/util.hpp>
#include <opencv2/stitching/detail/warpers.hpp>
#include <opencv2/stitching/warpers.hpp>

using namespace cv;
using namespace cv::detail;

struct pano_t
{
  std::vector<Mat> frames;  // CV_16FC3, linear
  std::vector<double> focals;  // each frame's focal length in its pixels, 0 if not known
  double vmax = 1.0;        // the brightest value of any frame
};

// features are found at 2 MP: OpenCV's sample uses 0.6, which leaves a
// distant skyline a few pixels high. seams and gains need far less
static const double _WORK_PIXELS = 2e6, _SEAM_PIXELS = 1e5;
// past this the blend alone needs several GB (about 14 bytes a pixel)
static const double _MAX_CANVAS = 250e6;

// the log code of the blend: v in [0, vmax] onto [0, 32767], which keeps
// some 1500 steps a stop at the top and still a few at 2^-12
static const double _A = 1024.0;

pano_t *pano_new(void)
{
  return new pano_t();
}

void pano_free(pano_t *p)
{
  delete p;
}

gboolean pano_add(pano_t *p, const float *rgba, const int width, const int height, const float scale[3],
                  const double focal, char **err)
{
  try
  {
    Mat in(height, width, CV_32FC4, (void *)rgba), rgb, half;
    cvtColor(in, rgb, COLOR_RGBA2RGB);
    multiply(rgb, Scalar(scale[0], scale[1], scale[2]), rgb);
    double lo, hi;
    minMaxLoc(rgb.reshape(1), &lo, &hi);
    p->vmax = std::max(p->vmax, hi);
    rgb.convertTo(half, CV_16F);
    p->frames.push_back(half);
    p->focals.push_back(focal);
    return TRUE;
  }
  catch(const std::exception &e)
  {
    *err = g_strdup_printf("cannot keep the frame: %s", e.what());
    return FALSE;
  }
}

static Mat _float(const Mat &half)
{
  Mat f;
  half.convertTo(f, CV_32F);
  return f;
}

// an 8-bit copy for the seams, gamma-encoded as a display would show it
static Mat _gamma8(const Mat &lin)
{
  Mat g, out;
  pow(max(lin, 0.0), 1.0 / 2.2, g);
  g.convertTo(out, CV_8U, 255.0);
  return out;
}

// an 8-bit copy for features, log-encoded, 14 stops below 2.0: an exposure
// difference between frames becomes an offset, which SIFT ignores, and a
// dark frame (a dawn sky's far end) keeps its detail
static Mat _log8(const Mat &lin)
{
  Mat t = max(lin, 0.0) + 1e-4, l, out;
  log(t, l);
  const double lo = std::log(2.0 / 16384.0), hi = std::log(2.0);
  l.convertTo(out, CV_8U, 255.0 / (hi - lo), -255.0 * lo / (hi - lo));
  return out;
}

static Mat _encode(const Mat &lin, const double vmax)
{
  Mat t = max(lin, 0.0) * _A + 1.0, l, out;
  log(t, l);
  l.convertTo(out, CV_16S, 32767.0 / std::log(1.0 + _A * vmax));
  return out;
}

// how far the cameras look, across and up, in radians: each one's view
// about the direction it faces
static void _span(const std::vector<CameraParams> &cams, const std::vector<Size> &sizes, double *across,
                  double *up)
{
  double l = 1e9, r = -1e9, b = 1e9, t = -1e9;
  for(size_t i = 0; i < cams.size(); i++)
  {
    Mat R;
    cams[i].R.convertTo(R, CV_64F);
    const double yaw = std::atan2(R.at<double>(0, 2), R.at<double>(2, 2));
    const double pitch = std::asin(std::clamp(-R.at<double>(1, 2), -1.0, 1.0));
    const double hw = std::atan(sizes[i].width / (2.0 * cams[i].focal));
    const double hh = std::atan(sizes[i].height / (2.0 * cams[i].focal));
    l = std::min(l, yaw - hw);
    r = std::max(r, yaw + hw);
    b = std::min(b, pitch - hh);
    t = std::max(t, pitch + hh);
  }
  *across = r - l;
  *up = t - b;
}

// a canvas past _MAX_CANVAS, or a frame warped wider or taller than the
// 32767 pixels OpenCV's remap takes. Rect's area() is an int, which a
// runaway canvas overflows
static bool _too_large(const Rect &dst, const std::vector<Size> &frames)
{
  if((double)dst.width * dst.height > _MAX_CANVAS) return true;
  for(const Size &s : frames)
    if(s.width >= SHRT_MAX || s.height >= SHRT_MAX) return true;
  return false;
}

static Ptr<WarperCreator> _warper(const pano_projection_t projection)
{
  if(projection == PANO_PERSPECTIVE) return makePtr<cv::PlaneWarper>();
  if(projection == PANO_CYLINDRICAL) return makePtr<cv::CylindricalWarper>();
  return makePtr<cv::SphericalWarper>();
}

// the largest rectangle of `mask` that is all set, by the rows' run
// heights (the largest rectangle in a histogram, one row at a time)
static Rect _inside(const Mat &mask)
{
  std::vector<int> run(mask.cols + 1, 0), stack;
  Rect best;
  for(int y = 0; y < mask.rows; y++)
  {
    const uchar *row = mask.ptr<uchar>(y);
    for(int x = 0; x < mask.cols; x++) run[x] = row[x] ? run[x] + 1 : 0;
    stack.clear();
    for(int x = 0; x <= mask.cols; x++)
    {
      while(!stack.empty() && run[stack.back()] >= run[x])
      {
        const int h = run[stack.back()];
        stack.pop_back();
        const int left = stack.empty() ? 0 : stack.back() + 1;
        if((x - left) * h > best.area()) best = Rect(left, y - h + 1, x - left, h);
      }
      stack.push_back(x);
    }
  }
  return best;
}

// the crop, found on a copy about 1000 pixels across, brought back inside
static Rect _auto_crop(const Mat &mask)
{
  const double s = std::max(1.0, mask.cols / 1000.0);
  Mat small, full;
  resize(mask, small, Size(std::max(1, (int)(mask.cols / s)), std::max(1, (int)(mask.rows / s))), 0, 0,
         INTER_AREA);
  full = small == 255;
  const Rect r = _inside(full);
  if(r.area() == 0) return Rect(0, 0, mask.cols, mask.rows);
  const int x0 = (int)std::ceil(r.x * s) + 1, y0 = (int)std::ceil(r.y * s) + 1;
  const int x1 = std::min(mask.cols, (int)std::floor((r.x + r.width) * s) - 1);
  const int y1 = std::min(mask.rows, (int)std::floor((r.y + r.height) * s) - 1);
  return x1 > x0 && y1 > y0 ? Rect(x0, y0, x1 - x0, y1 - y0) : Rect(0, 0, mask.cols, mask.rows);
}

// a stage's step, as an exception once the caller stops the stitch
struct _stopped {};
static void _step(const pano_step_t step, void *data, const char *stage, const int done, const int total)
{
  if(step && !step(stage, done, total, data)) throw _stopped();
}

float *pano_stitch(pano_t *p, pano_projection_t projection, const gboolean crop, const pano_step_t step,
                   void *data, int *width, int *height, int *used, char **err)
{
  const int n = (int)p->frames.size();
  if(n < 2)
  {
    *err = g_strdup("a panorama needs two photos or more");
    return NULL;
  }
  try
  {
    double area = 0.0;
    for(const Mat &f : p->frames) area = std::max(area, (double)f.size().area());
    const double work_scale = std::min(1.0, std::sqrt(_WORK_PIXELS / area));
    const double seam_scale = std::min(1.0, std::sqrt(_SEAM_PIXELS / area));

    std::vector<ImageFeatures> features(n);
    std::vector<Mat> seam8(n);
    std::vector<Size> work_sizes(n);
    // a low contrast threshold (OpenCV's is 0.04): a sky and its water
    // give few features otherwise
    Ptr<Feature2D> finder = SIFT::create(0, 3, 0.01);
    for(int i = 0; i < n; i++)
    {
      _step(step, data, "finding features", i, n);
      const Mat f = _float(p->frames[i]);
      Mat w;
      resize(f, w, Size(), work_scale, work_scale, INTER_AREA);
      computeImageFeatures(finder, _log8(w), features[i]);
      features[i].img_idx = i;
      work_sizes[i] = w.size();
      resize(f, w, Size(), seam_scale, seam_scale, INTER_AREA);
      seam8[i] = _gamma8(w);
    }

    _step(step, data, "aligning", 0, 1);
    std::vector<MatchesInfo> pairwise;
    // OpenCV drops a pair above a confidence of 3 as "the same image"
    // (matchers.cpp), which loses the neighbors of a tripod's overlapping
    // frames, so the limit is lifted
    BestOf2NearestMatcher matcher(false, 0.3f, 6, 6, 1e9);
    matcher(features, pairwise);
    matcher.collectGarbage();
    std::vector<int> keep = leaveBiggestComponent(features, pairwise, 1.0f);
    if(keep.size() < 2)
    {
      *err = g_strdup("the photos do not overlap enough to be stitched");
      return NULL;
    }
    std::vector<Mat> frames, seams;
    std::vector<Size> sizes;
    std::vector<double> lens;
    for(const int k : keep)
    {
      frames.push_back(p->frames[k]);
      seams.push_back(seam8[k]);
      sizes.push_back(work_sizes[k]);
      lens.push_back(p->focals[k] * work_scale);
    }
    p->frames.clear();
    const int m = (int)frames.size();

    std::vector<CameraParams> cams;
    HomographyBasedEstimator estimator;
    if(!estimator(features, pairwise, cams))
    {
      *err = g_strdup("the photos could not be aligned");
      return NULL;
    }
    // the bundle adjustment starts from the lens's focal length: the
    // estimator finds one only from the rotation between the frames, and
    // without much of one (frames shot close together, or the same frame
    // twice) guesses, which the adjustment then cannot correct and the
    // panorama comes out warped and zoomed in
    const gboolean known = std::all_of(lens.begin(), lens.end(), [](const double f) { return f > 0.0; });
    for(int i = 0; i < (int)cams.size(); i++)
    {
      Mat R;
      cams[i].R.convertTo(R, CV_32F);
      cams[i].R = R;
      if(known) cams[i].focal = lens[i];
    }
    BundleAdjusterRay adjuster;
    adjuster.setConfThresh(1.0);
    if(!adjuster(features, pairwise, cams))
    {
      *err = g_strdup("the photos could not be aligned");
      return NULL;
    }
    std::vector<Mat> rmats;
    for(const CameraParams &c : cams) rmats.push_back(c.R.clone());
    waveCorrect(rmats, WAVE_CORRECT_HORIZ);
    // the correction levels the horizon by a few degrees. it finds the
    // horizon from how the cameras turn, so frames that hardly do leave it
    // free to tip the whole panorama on its side, a cylinder hundreds of
    // thousands of pixels tall: then the cameras stay as aligned
    double turned = 0.0;
    for(int i = 0; i < m; i++)
    {
      Mat d = rmats[i] * cams[i].R.t();
      d.convertTo(d, CV_64F);
      turned = std::max(turned, std::acos(std::clamp((trace(d)[0] - 1.0) / 2.0, -1.0, 1.0)));
    }
    if(turned <= 20.0 * CV_PI / 180.0)
      for(int i = 0; i < m; i++) cams[i].R = rmats[i];
    std::vector<double> focals;
    for(const CameraParams &c : cams) focals.push_back(c.focal);
    std::sort(focals.begin(), focals.end());
    const double warped_scale = m % 2 ? focals[m / 2] : (focals[m / 2 - 1] + focals[m / 2]) * 0.5;

    // Auto, as Lightroom's: Perspective while the view is narrow enough
    // for a flat plane, Cylindrical for a row, Spherical past that
    const gboolean automatic = projection == PANO_AUTO;
    if(automatic)
    {
      double across, up;
      _span(cams, sizes, &across, &up);
      const double deg = CV_PI / 180.0;
      projection = across <= 100 * deg && up <= 100 * deg ? PANO_PERSPECTIVE
                 : up <= 90 * deg                         ? PANO_CYLINDRICAL
                                                          : PANO_SPHERICAL;
    }

    // the full-size cameras and the canvas they make; a flat plane grows
    // without bound towards 180 degrees, so Auto falls back to Cylindrical
    const double compose_scale = 1.0 / work_scale;
    std::vector<CameraParams> full = cams;
    for(CameraParams &c : full)
    {
      c.focal *= compose_scale;
      c.ppx *= compose_scale;
      c.ppy *= compose_scale;
    }
    Ptr<RotationWarper> fw;
    std::vector<Point> corners(m);
    std::vector<Size> fsizes(m);
    Rect dst;
    for(int attempt = 0; attempt < 2; attempt++)
    {
      fw = _warper(projection)->create((float)(warped_scale * compose_scale));
      for(int i = 0; i < m; i++)
      {
        Mat K;
        full[i].K().convertTo(K, CV_32F);
        const Rect roi = fw->warpRoi(frames[i].size(), K, full[i].R);
        corners[i] = roi.tl();
        fsizes[i] = roi.size();
      }
      dst = resultRoi(corners, fsizes);
      if(!_too_large(dst, fsizes) || !automatic || projection != PANO_PERSPECTIVE) break;
      projection = PANO_CYLINDRICAL;
    }
    if(_too_large(dst, fsizes))
    {
      *err = g_strdup_printf("the panorama would be %d x %d pixels, too large to stitch%s", dst.width, dst.height,
                             projection == PANO_PERSPECTIVE ? "; try Cylindrical or Spherical" : "");
      return NULL;
    }

    // seams and gains, at the seam scale
    _step(step, data, "finding seams", 0, 1);
    const double seam_aspect = seam_scale / work_scale;
    Ptr<RotationWarper> sw = _warper(projection)->create((float)(warped_scale * seam_aspect));
    std::vector<Point> scorners(m);
    std::vector<UMat> warped8(m), masks(m), warpedf(m), linear8(m);
    for(int i = 0; i < m; i++)
    {
      Mat K;
      cams[i].K().convertTo(K, CV_32F);
      K.at<float>(0, 0) *= (float)seam_aspect;
      K.at<float>(0, 2) *= (float)seam_aspect;
      K.at<float>(1, 1) *= (float)seam_aspect;
      K.at<float>(1, 2) *= (float)seam_aspect;
      const Mat mask(seams[i].size(), CV_8U, Scalar::all(255));
      scorners[i] = sw->warp(seams[i], K, cams[i].R, INTER_LINEAR, BORDER_REFLECT, warped8[i]);
      sw->warp(mask, K, cams[i].R, INTER_NEAREST, BORDER_CONSTANT, masks[i]);
      warped8[i].convertTo(warpedf[i], CV_32F);
      // a gain is the model of a linear copy, not of a gamma-encoded one
      Mat g, l;
      warped8[i].getMat(ACCESS_READ).convertTo(g, CV_32F, 1.0 / 255.0);
      pow(g, 2.2, l);
      l.convertTo(linear8[i], CV_8U, 255.0);
    }
    GainCompensator compensator(1);
    static_cast<ExposureCompensator &>(compensator).feed(scorners, linear8, masks);
    std::vector<Mat> gains;
    compensator.getMatGains(gains);
    GraphCutSeamFinder(GraphCutSeamFinderBase::COST_COLOR_GRAD).find(warpedf, scorners, masks);
    warped8.clear();
    warpedf.clear();
    linear8.clear();

    // the full-size frames, one at a time, into the blender
    const double vmax = p->vmax * 1.5;
    const float blend_width = std::sqrt((float)dst.area()) * 0.05f;
    MultiBandBlender blender(false, std::max(1, (int)std::ceil(std::log(blend_width) / std::log(2.0)) - 1));
    blender.prepare(dst);
    for(int i = 0; i < m; i++)
    {
      _step(step, data, "blending", i, m);
      Mat K, wf, wm, seam, dilated;
      full[i].K().convertTo(K, CV_32F);
      const Mat f = _float(frames[i]);
      frames[i].release();
      const Mat mask(f.size(), CV_8U, Scalar::all(255));
      fw->warp(f, K, full[i].R, INTER_LINEAR, BORDER_REFLECT, wf);
      fw->warp(mask, K, full[i].R, INTER_NEAREST, BORDER_CONSTANT, wm);
      wf *= gains[i].at<double>(0, 0);
      dilate(masks[i], dilated, Mat());
      resize(dilated, seam, wm.size(), 0, 0, INTER_LINEAR_EXACT);
      wm = seam & wm;
      blender.feed(_encode(wf, vmax), wm, corners[i]);
    }
    _step(step, data, "blending", m, m);
    Mat code, covered;
    blender.blend(code, covered);

    const Rect out = crop ? _auto_crop(covered) : Rect(0, 0, code.cols, code.rows);
    float *rgb = (float *)g_try_malloc((size_t)out.width * out.height * 3 * sizeof(float));
    if(!rgb)
    {
      *err = g_strdup_printf("not enough memory for a %d x %d panorama", out.width, out.height);
      return NULL;
    }
    const double k = std::log(1.0 + _A * vmax) / 32767.0;
    for(int y = 0; y < out.height; y++)
    {
      const short *c = code.ptr<short>(out.y + y) + 3 * out.x;
      const uchar *v = covered.ptr<uchar>(out.y + y) + out.x;
      float *o = rgb + (size_t)y * out.width * 3;
      for(int x = 0; x < out.width; x++)
        for(int ch = 0; ch < 3; ch++)
          o[3 * x + ch] = v[x] ? (float)std::max(0.0, (std::exp(c[3 * x + ch] * k) - 1.0) / _A) : 0.0f;
    }
    *width = out.width;
    *height = out.height;
    *used = m;
    return rgb;
  }
  catch(const _stopped &)
  {
    *err = g_strdup("stopped");
    return NULL;
  }
  catch(const std::exception &e)
  {
    *err = g_strdup_printf("stitching failed: %s", e.what());
    return NULL;
  }
}
