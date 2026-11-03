// Standalone CPU library diagnostic; does not render through Immage.
// Build: c++ -std=c++17 -O2 verify/lensfun-profiles.cc $(pkg-config --cflags --libs lensfun) -o /tmp/lensfun-profiles
#include <lensfun.h>
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <vector>

int main(int argc, char **argv)
{
  if(argc != 2) { std::fprintf(stderr, "usage: lensfun-profiles DATABASE_DIRECTORY\n"); return 2; }
  lfDatabase db;
  std::vector<std::filesystem::path> files;
  for(const auto &entry : std::filesystem::directory_iterator(argv[1]))
    if(entry.path().extension() == ".xml") files.push_back(entry.path());
  std::sort(files.begin(), files.end());
  if(files.empty()) return 3;
  for(const auto &file : files) if(db.Load(file.c_str()) != LF_NO_ERROR) return 4;
  std::puts("profile\tmaker\tmodel\tcrop\tfocal\taperture\tdistance\twidth\treverse\tflags\tvalue\tchanged\tmax_delta\tnegative_nonzero\tclamped_changed\tclamped_max_delta\tnonfinite");
  unsigned profiles = 0;
  for(auto lenses = db.GetLenses(); *lenses; ++lenses)
  {
    const auto *lens = *lenses;
    if(!lens->CalibVignetting || !lens->CalibVignetting[0]) continue;
    const auto &cal = *lens->CalibVignetting[0];
    if(!(lens->CropFactor > 0 && cal.Focal > 0 && cal.Aperture > 0)) continue;
    ++profiles;
    for(int width : {96, 512, 4640}) for(bool reverse : {false, true})
    {
      lfModifier mod(lens, lens->CropFactor, width, width * 3 / 4);
      const int flags = mod.Initialize(lens, LF_PF_F32, cal.Focal, cal.Aperture,
          cal.Distance, 1, LF_RECTILINEAR, LF_MODIFY_VIGNETTING, reverse);
      if(!(flags & LF_MODIFY_VIGNETTING)) return 5;
      for(float value : {-1.f, 0.f, .01f, .5f, 1.f, 2.f, 10.f})
      {
        std::vector<float> direct(width * 4, value), factors(width * 4, .5f);
        const auto roles = LF_CR_4(RED, GREEN, BLUE, UNKNOWN);
        if(!mod.ApplyColorModification(direct.data(), 0, 0, width, 1, roles, width * 16)
           || !mod.ApplyColorModification(factors.data(), 0, 0, width, 1, roles, width * 16)) return 6;
        unsigned changed = 0, negative_nonzero = 0, clamped_changed = 0, nonfinite = 0;
        double maximum = 0, clamped_maximum = 0;
        for(int x = 0; x < width; ++x) for(int c = 0; c < 3; ++c)
        {
          const float a = direct[x * 4 + c], b = value * (2 * factors[x * 4 + c]);
          if(!std::isfinite(a) || !std::isfinite(b)) { ++nonfinite; continue; }
          const double delta = std::fabs(double(a) - b);
          changed += delta != 0;
          maximum = std::max(maximum, delta);
          negative_nonzero += value < 0 && a != 0;
          const double clamped_delta = std::fabs(double(a) - std::max(b, 0.f));
          clamped_changed += clamped_delta != 0;
          clamped_maximum = std::max(clamped_maximum, clamped_delta);
        }
        std::printf("%u\t%s\t%s\t%.9g\t%.9g\t%.9g\t%.9g\t%d\t%d\t%d\t%.9g\t%u\t%.17g\t%u\t%u\t%.17g\t%u\n",
            profiles, lens->Maker, lens->Model, lens->CropFactor, cal.Focal,
            cal.Aperture, cal.Distance, width, reverse, flags, value, changed,
            maximum, negative_nonzero, clamped_changed, clamped_maximum, nonfinite);
      }
    }
  }
  return profiles ? 0 : 7;
}
