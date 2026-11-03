#!/usr/bin/env python3
"""Build an isolated candidate Lensfun CPU reference diagnostic (not a migration).

Requires the frozen candidate source and its configured, deployed Ninja build.
The output must be new; original engine, plugins and source are never written.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess


def replace_once(text, old, new):
    if text.count(old) != 1:
        raise ValueError(f'expected exactly one source anchor: {old[:100]}')
    return text.replace(old, new)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--build', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    source, build, output = (p.resolve() for p in (args.source, args.build, args.output))
    if output.exists() or output == source or output == build:
        raise ValueError('output must be a new directory')
    original = source / 'src/iop/lens.cc'
    text = original.read_text()
    # CPU coordinate grids at step 1 have no buffer: _lens_grid_row calls
    # Lensfun with the actual row origin and width, including split tile rows.
    text = replace_once(text, 'for(int step = LENS_GRID_STEP; step >= 1; step /= 2)',
                        'for(int step = 1; step >= 1; step /= 2)')
    text = replace_once(text, '''    const dt_iop_roi_t *vroi = d->inverse ? roi_out : roi_in;
    ok = _lens_grid_build(modifier, TRUE, buffer, vroi->x, vroi->y,
                          vroi->width, vroi->height, &c->vig);''',
                        '''    // Diagnostic: actual pixels are evaluated below, no factor grid.
    c->vig.step = 1;''')
    # Preserve the old CPU ordering and Lensfun channel roles/row stride.
    for roi, image, shared in [('roi_out', 'ovoid', ''), ('roi_in', 'buf', ' shared(buf)')]:
        start = text.index(f'      const size_t vigsize = (size_t){roi}->width * 4;',
                           text.index('static void _process_lf'))
        end = text.index('      dt_free_align(vig);', start) + len('      dt_free_align(vig);')
        text = text[:start] + f'''      DT_OMP_FOR(shared(modifier){shared})
      for(int y = 0; y < {roi}->height; y++)
      {{
        float *row = (float *){image} + (size_t)y * {roi}->width * ch;
        modifier->ApplyColorModification(row, {roi}->x, {roi}->y + y,
                                         {roi}->width, 1,
                                         ch == 3 ? LF_CR_3(RED, GREEN, BLUE) : LF_CR_4(RED, GREEN, BLUE, UNKNOWN),
                                         ch * {roi}->width);
      }}''' + text[end:]
    text = replace_once(text, '    _commit_params_lf(self, p, pipe, piece);',
                        '''    _commit_params_lf(self, p, pipe, piece);
    // Actual-pixel library evaluation has no equivalent device kernel here.
    piece->process_cl_ready = FALSE;''')
    intro = build / 'lib/darktable/plugins/introspection_lens.cc'
    entries = json.loads((build / 'compile_commands.json').read_text())
    entry = next(e for e in entries if Path(e['file']) == intro)
    command = shlex.split(entry['command'])
    commands = subprocess.check_output(['ninja', '-C', str(build), '-t', 'commands',
                                        'lib/darktable/plugins/liblens.so'], text=True).splitlines()
    link = next(line for line in reversed(commands) if '-o lib/darktable/plugins/liblens.so' in line)
    if not (link.startswith(': && ') and link.endswith(' && :')):
        raise ValueError('unsupported Ninja link wrapper')
    link_args = shlex.split(link[len(': && '):-len(' && :')])
    output.mkdir(parents=True)
    for folder in ('bin', 'lib', 'share'):
        shutil.copytree(build / folder, output / folder,
                        copy_function=lambda a, b: os.symlink(os.path.realpath(a), b))
    src = output / 'lens-direct.cc'
    src.write_text(text)
    generated = output / 'introspection_lens.cc'
    generated.write_text(replace_once(intro.read_text(), str(original), str(src)))
    obj = output / 'lens-direct.o'
    command[command.index('-o') + 1] = str(obj)
    if command[-1] != str(intro):
        raise ValueError('unsupported compilation command')
    command[-1] = str(generated)
    plugin = output / 'lib/darktable/plugins/liblens.so'
    plugin.unlink()  # Only unlink the copied symlink; never overwrite its target.
    link_args[link_args.index('-o') + 1] = str(plugin)
    link_args[link_args.index('lib/darktable/plugins/CMakeFiles/lens.dir/introspection_lens.cc.o')] = str(obj)
    # Keep link dependency output isolated as well.
    link_args = [f'-Wl,--dependency-file={output / "link.d"}'
                 if a.startswith('-Wl,--dependency-file=') else a for a in link_args]
    with (output / 'build.log').open('w') as log:
        for cmd in (command, link_args):
            subprocess.run(cmd, cwd=build, stdout=log, stderr=subprocess.STDOUT, check=True)
    hashes = {str(p): hashlib.sha256(p.read_bytes()).hexdigest()
              for p in (original, src, generated, plugin, build / 'bin/darktable-engine', Path(__file__))}
    (output / 'manifest.json').write_text(json.dumps({'diagnostic_only': True, 'sha256': hashes,
                                                    'compile': command, 'link': link_args}, indent=2) + '\n')
    print(output)


if __name__ == '__main__':
    main()
