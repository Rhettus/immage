#!/usr/bin/env python3
"""Build an isolated signed-input Lensfun diagnostic plugin, never production.

Run the deployed copy with pin-pixels.py and compare SIGNED_LENS records by
coordinates (OpenMP log order is unspecified). This deliberately replaces RGB
at the actual vignetting boundary, or at module input with --geometry.
Neither mode models real-camera inputs.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess


def replace_once(text, old, new):
    if text.count(old) != 1:
        raise ValueError(f'expected exactly one source anchor: {old[:100]}')
    return text.replace(old, new)


HELPER = r'''// Diagnostic-only signed values at the actual Lensfun vignetting boundary.
static void _signed_lens_input(float *row, int x, int y, int width, int ch)
{
  const float values[] = {-1.f, -.01f, -0.f, 0.f, .01f, .5f, 1.f, 2.f, 10.f};
  for(int i = 0; i < width; i++)
  {
    for(int c = 0; c < 3; c++) row[i * ch + c] = values[(x + i + y + c) % 9];
    if(ch == 4) row[i * ch + 3] = .25f;
  }
}

static void _signed_lens_trace(const float *row, int x, int y, int width, int ch, int inverse)
{
  size_t negative = 0, positive = 0, nonfinite = 0, alpha_changed = 0;
  for(int i = 0; i < width; i++)
  {
    for(int c = 0; c < 3; c++)
    {
      const float v = row[i * ch + c];
      negative += v < 0.f;
      positive += v > 0.f;
      nonfinite += !isfinite(v);
    }
    if(ch == 4) alpha_changed += row[i * ch + 3] != .25f;
  }
  gchar *hash = g_compute_checksum_for_data(G_CHECKSUM_SHA256,
    (const guchar *)row, (gsize)width * ch * sizeof(float));
  fprintf(stderr, "SIGNED_LENS %d %d %d %d %d %zu %zu %zu %zu %s\n",
          inverse, x, y, width, ch, negative, positive, nonfinite, alpha_changed, hash);
  g_free(hash);
}

'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--geometry', action='store_true',
                        help='Inject at module input and trace RGB after active geometry')
    parser.add_argument('--source', type=Path, required=True,
                        help='Configured source tree for this deployed build')
    parser.add_argument('--input-source', type=Path,
                        help='Optional isolated direct-prototype lens source')
    parser.add_argument('--build', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    source, build, output = (p.resolve() for p in (args.source, args.build, args.output))
    if output.exists() or output == source or output == build:
        raise ValueError('output must be a new directory')
    original = source / 'src/iop/lens.cc'
    input_source = (args.input_source or original).resolve()
    text = input_source.read_text()
    anchor = 'static void _process_lf(dt_iop_module_t *self,'
    text = replace_once(text, anchor, HELPER + anchor)
    # Restrict substitutions to _process_lf, excluding CPU factor-grid helpers
    # and OpenCL setup. Both forward and reverse actual-pixel calls are required.
    start = text.index(anchor)
    end = text.index('\n}\n', start) + 3
    process = text[start:end]
    pattern = r'modifier->ApplyColorModification\((\w+), (roi_(?:in|out))->x, \2->y \+ y,.*?\);'
    def instrument(match):
        row, roi = match.group(1, 2)
        coords = f'{roi}->x, {roi}->y + y, {roi}->width, ch'
        return (f'_signed_lens_input({row}, {coords});\n        ' + match.group(0)
                + f'\n        _signed_lens_trace({row}, {coords}, d->inverse);')
    process, count = re.subn(pattern, instrument, process, flags=re.S)
    if count != 2:
        raise ValueError(f'expected two actual-pixel calls, found {count}')
    if args.geometry:
        # Geometry output alpha is unspecified outside mask display: hash RGB only.
        process = re.sub(r'        _signed_lens_(?:input|trace)\([^;]+;\n', '', process)
        process = replace_once(process, 'const void *const ivoid,', 'const void *const source_void,')
        process = replace_once(process, '  const int ch_width =', r'''  const size_t signed_count = (size_t)roi_in->width * roi_in->height * ch;
  float *const signed_input = dt_alloc_align_float(signed_count);
  if(!signed_input) abort();
  for(int y = 0; y < roi_in->height; y++)
    _signed_lens_input(signed_input + (size_t)y * roi_in->width * ch,
                       roi_in->x, roi_in->y + y, roi_in->width, ch);
  const void *const ivoid = signed_input;
  const int ch_width =''')
        process = process.replace('    return;', '    dt_free_align(signed_input);\n    abort(); // A bypass is invalid geometry evidence.')
        head, anchor_delete, tail = process.rpartition('  delete modifier;')
        if not anchor_delete:
            raise ValueError('missing modifier cleanup')
        process = head + r'''  if(!(modflags & (LF_MODIFY_TCA | LF_MODIFY_DISTORTION | LF_MODIFY_GEOMETRY | LF_MODIFY_SCALE)))
    abort(); // Requested flags alone do not prove an active transform.
  for(int y = 0; y < roi_out->height; y++)
  {
    const float *row = (const float *)ovoid + (size_t)y * roi_out->width * ch;
    // Pack RGB; synthetic alpha excludes unspecified output alpha from the hash.
    float *packed = dt_alloc_align_float((size_t)roi_out->width * 4);
    if(!packed) abort();
    for(int x = 0; x < roi_out->width; x++)
    {
      for(int c = 0; c < 3; c++) packed[4*x+c] = row[ch*x+c];
      packed[4*x+3] = .25f;
    }
    _signed_lens_trace(packed, roi_out->x, roi_out->y + y, roi_out->width, 4, d->inverse);
    dt_free_align(packed);
  }
  dt_free_align(signed_input);
  delete modifier;''' + tail
    text = text[:start] + process + text[end:]
    intro = build / 'lib/darktable/plugins/introspection_lens.cc'
    entries = json.loads((build / 'compile_commands.json').read_text())
    entry = next(e for e in entries if Path(e['file']) == intro)
    command = shlex.split(entry['command'])
    if (build / 'build.ninja').exists():
        commands = subprocess.check_output(['ninja', '-C', str(build), '-t', 'commands',
                                            'lib/darktable/plugins/liblens.so'], text=True).splitlines()
        link = next(line for line in reversed(commands) if '-o lib/darktable/plugins/liblens.so' in line)
        if not (link.startswith(': && ') and link.endswith(' && :')):
            raise ValueError('unsupported Ninja link wrapper')
        link_args = shlex.split(link[len(': && '):-len(' && :')])
        link_cwd = build
        object_name = 'lib/darktable/plugins/CMakeFiles/lens.dir/introspection_lens.cc.o'
    else:
        link_cwd = build / 'lib/darktable/plugins'
        link_args = shlex.split((link_cwd / 'CMakeFiles/lens.dir/link.txt').read_text())
        object_name = 'CMakeFiles/lens.dir/introspection_lens.cc.o'
    output.mkdir(parents=True)
    for folder in ('bin', 'lib', 'share'):
        shutil.copytree(build / folder, output / folder,
                        copy_function=lambda a, b: os.symlink(os.path.realpath(a), b))
    src = output / 'lens-signed.cc'
    src.write_text(text)
    generated = output / 'introspection_lens.cc'
    generated.write_text(replace_once(intro.read_text(), str(original), str(src)))
    obj = output / 'lens-signed.o'
    command[command.index('-o') + 1] = str(obj)
    if command[-1] != str(intro):
        raise ValueError('unsupported compilation command')
    command[-1] = str(generated)
    plugin = output / 'lib/darktable/plugins/liblens.so'
    plugin.unlink()  # Only unlink the copied symlink; never overwrite its target.
    link_args[link_args.index('-o') + 1] = str(plugin)
    link_args[link_args.index(object_name)] = str(obj)
    # Keep link dependency output isolated as well.
    link_args = [f'-Wl,--dependency-file={output / "link.d"}'
                 if a.startswith('-Wl,--dependency-file=') else a for a in link_args]
    with (output / 'build.log').open('w') as log:
        for cmd, cwd in ((command, entry['directory']), (link_args, link_cwd)):
            subprocess.run(cmd, cwd=cwd, stdout=log, stderr=subprocess.STDOUT, check=True)
    hashes = {str(p): hashlib.sha256(p.read_bytes()).hexdigest()
              for p in (original, input_source, src, generated, plugin, build / 'bin/darktable-engine', Path(__file__))}
    (output / 'manifest.json').write_text(json.dumps({'diagnostic_only': True, 'geometry': args.geometry, 'sha256': hashes,
                                                    'compile': command, 'link': link_args}, indent=2) + '\n')
    print(output)


if __name__ == '__main__':
    main()
