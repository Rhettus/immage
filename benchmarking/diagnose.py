#!/usr/bin/env python3
"""Analyze GUI benchmark latency and export independent frontend/native timelines."""
import argparse
import collections
import json
import math
from pathlib import Path
import statistics


def distribution(values):
    values = sorted(values)
    return {'n': len(values), 'median': statistics.median(values) if values else None,
            'p95': values[max(0, math.ceil(.95 * len(values)) - 1)] if values else None}


def operation_spans(events):
    starts = {e['id']: e for e in events if e['name'].endswith('.start') and 'id' in e}
    spans = []
    for event in events:
        start = starts.get(event.get('id'))
        if start and event is not start and event['name'].rsplit('.', 1)[0] == start['name'][:-6]:
            spans.append({'id': start['id'], 'name': start['name'][:-6], 'start': start['at'],
                          'end': event['at'], 'label': start.get('label', ''),
                          'outcome': event['name'].rsplit('.', 1)[1], 'data': start.get('data') or {}})
    return spans


def intersection(a, b, c, d):
    return max(0, min(b, d) - max(a, c))


def covered(intervals):
    total, end = 0, float('-inf')
    for a, b in sorted(intervals):
        total += max(0, b - max(a, end))
        end = max(end, b)
    return total


def native_waits(spans, request):
    results = []
    for span in spans:
        if request is None or span.get('requestId') != request:
            continue
        start, end = span['waitAt'], span['acquiredAt']
        owners, intervals = [], []
        for owner in spans:
            if owner['id'] == span['id']:
                continue
            duration = intersection(start, end, owner['acquiredAt'], owner['releasedAt'])
            if duration > 0:
                owners.append({'operation': owner['operation'], 'requestId': owner.get('requestId'), 'ms': duration})
                intervals.append((max(start, owner['acquiredAt']), min(end, owner['releasedAt'])))
        results.append({'nativeSpanId': span['id'], 'waitMs': end-start, 'owners': owners,
                        'unattributedMs': max(0, end-start-covered(intervals))})
    return results


def summarize(report):
    diagnostics = report.get('diagnostics') or {}
    events = diagnostics.get('events', [])
    spans = operation_spans(events)
    native = diagnostics.get('native', {}).get('spans', [])
    starts = {s['id']: s for s in spans if s['name'] == 'render'}
    samples = report.get('samples', [])
    frames, groups, first = [], collections.defaultdict(list), set()
    for frame in sorted(samples, key=lambda f: f['at']):
        diagnostic = frame.get('diagnostic') or {}
        label = diagnostic.get('label', frame.get('label', '?'))
        source = diagnostic.get('source', 'estimated' if frame.get('estimated') else 'native-or-reused')
        phase = 'release' if 'release' in label else 'first' if (label, source) not in first else 'sustained'
        if frame.get('kind') == 'edit' or phase == 'release':
            first.add((label, source))
            groups[(label, phase, source, frame['width'], frame['height'])].append(frame)
        request = diagnostic.get('requestId')
        start = starts.get(request)
        input_at = frame['at'] - frame['total']
        # Queue ends at setStart, before render invocation; both are frontend times.
        queue_end = frame['at'] - frame['total'] + frame.get('stages', {}).get('queue', 0)
        blockers, intervals = [], []
        for span in spans:
            if span['id'] == request:
                continue
            blocking = span['data'].get('blockingPump') or span['name'] == 'base.wait'
            duration = intersection(input_at, queue_end, span['start'], span['end'])
            if blocking and duration > 0:
                blockers.append({'operation': span['name'], 'id': span['id'], 'ms': duration, 'data': span['data']})
                intervals.append((max(input_at, span['start']), min(queue_end, span['end'])))
        overlaps = [s['id'] for s in spans if s['name'] == 'render' and s['id'] != request
                    and start and intersection(input_at, start['start'], s['start'], s['end']) > 0]
        frames.append({'frameId': diagnostic.get('frameId'), 'requestId': request, 'kind': frame.get('kind'),
                       'label': label, 'phase': phase, 'source': source, 'total': frame['total'],
                       'latestInputLatency': frame.get('latestInputLatency'), 'stages': frame.get('stages', {}),
                       'moduleTimings': frame.get('moduleTimings'),
                       'modules': sorted(frame.get('modules', []), key=lambda m:m.get('ms', 0), reverse=True)[:8],
                       'queue': {'blockers': blockers, 'coveredMs': covered(intervals),
                                 'unattributedMs': max(0, queue_end-input_at-covered(intervals))},
                       'priorOverlappingRequests': overlaps, 'nativeWaits': native_waits(native, request)})
    rows = []
    for (label, phase, source, width, height), values in sorted(groups.items()):
        values.sort(key=lambda f: f['at'])
        intervals = [b['at']-a['at'] for a, b in zip(values, values[1:]) if b['at'] > a['at']]
        rows.append({'label': label, 'phase': phase, 'source': source, 'width': width, 'height': height,
                     'latency': distribution([f['total'] for f in values]),
                     'latestInputLatency': distribution([f['latestInputLatency'] for f in values if f.get('latestInputLatency') is not None]),
                     'frameIntervals': distribution(intervals)})
    lifecycle = {}
    for event in events:
        data = event.get('data') or {}
        frame_id = data.get('frameId')
        if frame_id is None:
            continue
        if event['name'] == 'frame.created':
            lifecycle[frame_id] = {'frameId':frame_id, 'source':data.get('source'), 'requestId':data.get('requestId'),
                                   'outcome':'no-terminal-event', 'at':event['at']}
        if frame_id in lifecycle and event['name'] in ('frame.raf', 'frame.discarded', 'frame.notPresented', 'draw.skipped', 'draw.end'):
            lifecycle[frame_id].update(outcome=event['name'], at=event['at'], reason=data.get('reason'), details=data)
    cancellations = []
    for event in events:
        if event['name'] != 'base.cancelRequested':
            continue
        for request in (event.get('data') or {}).get('requestIds', []):
            span = starts.get(request)
            cancellations.append({'requestId':request, 'outcome':span['outcome'] if span else 'unfinished-or-missing',
                                  'completionAfterRequestMs':max(0, span['end']-event['at']) if span else None})
    outcomes = collections.Counter(e['name'] for e in events if e['name'].startswith(('frame.', 'estimate.'))
                                   or e['name'] in ('render.cancelled', 'render.failed'))
    return {'build': report.get('build'), 'groups': rows, 'frames': frames, 'outcomes': dict(outcomes),
            'eventCount': len(events), 'droppedEvents': diagnostics.get('droppedEvents', 0),
            'droppedNativeSpans': diagnostics.get('native', {}).get('droppedSpans', 0),
            'unfinished': diagnostics.get('unfinished', []), 'nativeUnfinished': diagnostics.get('native', {}).get('unfinished', []),
            'cancellations':cancellations, 'frameLifecycle':list(lifecycle.values()), 'spans': spans}


def analyze(report):
    result = summarize(report)
    print('Phase latency by first/sustained/release, source and actual dimensions (ms; nearest-rank P95)')
    for row in result['groups']:
        latency, latest = row['latency'], row['latestInputLatency']
        print(f"{row['label']} {row['phase']}: {row['width']}x{row['height']} {row['source']}, "
              f"n={latency['n']}, median={latency['median']:.1f}, p95={latency['p95']:.1f}"
              + (f", latest-input median={latest['median']:.1f}" if latest['n'] else ''))
    print('\nSlowest edit/release frames; queue blocker spans overlap and must not be added')
    relevant = [f for f in result['frames'] if f['kind'] == 'edit' or f['phase'] == 'release']
    for frame in sorted(relevant, key=lambda f: f['total'], reverse=True)[:15]:
        print(f"{frame['label']}: {frame['total']:.1f}ms, request={frame['requestId']}, "
              f"prior overlapping requests={frame['priorOverlappingRequests']}, stages={frame['stages']}")
        print(f"  Queue: {frame['queue']}; native lock waits: {frame['nativeWaits']}")
        print(f"  Modules: {frame['modules']}; timing status: {frame['moduleTimings']}")
    print(f"\nFrame lifecycle: {dict(collections.Counter(f['outcome'] for f in result['frameLifecycle']))}")
    print(f"\nCancellation completion delays: {result['cancellations']}")
    print(f"\nOutcomes: {result['outcomes']}")
    print(f"Diagnostic events: {result['eventCount']}, dropped: {result['droppedEvents']}; "
          f"native dropped: {result['droppedNativeSpans']}; unfinished operations: {len(result['unfinished'])}")
    if not result['eventCount']:
        print('Older report or diagnostics disabled: request attribution unavailable.')
    return result


def timelines(report):
    diagnostics = report.get('diagnostics') or {}
    events = diagnostics.get('events', [])
    trace = []
    spans = operation_spans(events)
    lanes = {name:i+1 for i,name in enumerate(sorted({s['name'] for s in spans}))}
    for span in spans:
        trace.append({'name': span['name'], 'cat': 'elapsed-not-cpu', 'ph': 'X', 'pid': 1, 'tid': lanes[span['name']],
                      'ts': span['start']*1000, 'dur': max(0, span['end']-span['start'])*1000,
                      'args': {**span['data'], 'id': span['id'], 'label': span['label'], 'outcome': span['outcome']}})
    span_ids = {s['id'] for s in spans}
    for event in events:
        if not event['name'].endswith('.start') and event.get('id') in span_ids:
            continue
        if event['name'].endswith('.start') and event.get('id') in span_ids:
            continue
        trace.append({'name': event['name'], 'ph': 'i', 's': 't', 'pid': 1, 'tid': 0,
                      'ts': event['at']*1000, 'args': {**(event.get('data') or {}), 'id': event.get('id'), 'label': event.get('label')}})
    native = []
    for span in diagnostics.get('native', {}).get('spans', []):
        for name, start, end, lane in [('engine lock wait', span['waitAt'], span['acquiredAt'], 1),
                                       (span['operation'], span['acquiredAt'], span['releasedAt'], 2)]:
            native.append({'name': name, 'ph': 'X', 'pid': 2, 'tid': lane, 'ts': start*1000,
                           'dur': max(0, end-start)*1000, 'args': span})
    for span in diagnostics.get('native', {}).get('unfinished', []):
        native.append({'name':'unfinished ' + span['operation'], 'ph':'i', 's':'t', 'pid':2, 'tid':3,
                       'ts':(span.get('acquiredAt') or span['waitAt'])*1000, 'args':span})
    for name, lane in [('events', 0), *lanes.items()]:
        trace.append({'name':'thread_name', 'ph':'M', 'pid':1, 'tid':lane, 'args':{'name':name}})
    for name, lane in [('lock waiters', 1), ('lock owner', 2), ('unfinished', 3)]:
        native.append({'name':'thread_name', 'ph':'M', 'pid':2, 'tid':lane, 'args':{'name':name}})
    trace.append({'name':'process_name', 'ph':'M', 'pid':1, 'args':{'name':'Frontend clock: elapsed operations'}})
    native.append({'name':'process_name', 'ph':'M', 'pid':2, 'args':{'name':'Native clock: not aligned with frontend'}})
    return ({'traceEvents': trace, 'displayTimeUnit': 'ms', 'clock': 'frontend; elapsed spans, not CPU time'},
            {'traceEvents': native, 'displayTimeUnit': 'ms', 'clock': 'native; NOT aligned with frontend'})


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report')
    parser.add_argument('--json', type=Path, help='write structured analysis')
    parser.add_argument('--trace', type=Path, help='write Chrome/Perfetto frontend timeline and a separate .native.json timeline')
    args = parser.parse_args()
    with open(args.report) as source:
        report = json.load(source)
    analysis = analyze(report)
    if args.json:
        args.json.write_text(json.dumps(analysis, indent=2) + '\n')
    if args.trace:
        frontend, native = timelines(report)
        args.trace.write_text(json.dumps(frontend) + '\n')
        args.trace.with_name(args.trace.stem + '.native.json').write_text(json.dumps(native) + '\n')
