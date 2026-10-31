"""Report analysis must distinguish overlapping requests from later work."""
import contextlib
import importlib.util
import io
import pathlib
import unittest

spec = importlib.util.spec_from_file_location('diagnose', pathlib.Path(__file__).parents[1] / 'benchmarking/diagnose.py')
diagnose = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagnose)


class DiagnoseTest(unittest.TestCase):
    def test_overlap_and_dispatch_phase(self):
        report = {'diagnostics': {'events': [
            {'name': 'render.start', 'id': 1, 'at': 10},
            {'name': 'render.end', 'id': 1, 'at': 50},
            {'name': 'render.start', 'id': 2, 'at': 55},
            {'name': 'render.end', 'id': 2, 'at': 80},
            {'name': 'render.start', 'id': 3, 'at': 90},
        ]}, 'samples': [{'kind': 'edit', 'at': 85, 'total': 50,
                         'width': 100, 'height': 80, 'label': 'release',
                         'diagnostic': {'label': 'exposure drag', 'requestId': 2},
                         'latestInputLatency': 30, 'stages': {'queue': 20}}]}
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            diagnose.analyze(report)
        text = output.getvalue()
        self.assertIn('exposure drag', text)
        self.assertIn('prior overlapping requests=[1]', text)
        self.assertIn('latest-input median=30.0', text)

    def test_old_report(self):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            diagnose.analyze({'samples': []})
        self.assertIn('Older report', output.getvalue())

    def test_wait_attribution_does_not_double_count_overlap(self):
        events = [
            {'name':'render.start', 'id':1, 'at':0, 'data':{'blockingPump':True}},
            {'name':'coalesce.start', 'id':2, 'at':5, 'data':{'blockingPump':True}},
            {'name':'render.end', 'id':1, 'at':15},
            {'name':'coalesce.end', 'id':2, 'at':20},
            {'name':'render.start', 'id':3, 'at':25},
            {'name':'render.end', 'id':3, 'at':35},
        ]
        native = [
            {'id':1,'requestId':1,'operation':'base','waitAt':0,'acquiredAt':2,'releasedAt':12},
            {'id':2,'requestId':3,'operation':'render','waitAt':5,'acquiredAt':14,'releasedAt':24},
        ]
        report = {'diagnostics':{'events':events,'native':{'spans':native}}, 'samples':[
            {'kind':'edit','at':40,'total':30,'width':1,'height':1,'stages':{'queue':15},
             'diagnostic':{'requestId':3,'label':'exposure drag'}}]}
        frame = diagnose.summarize(report)['frames'][0]
        self.assertEqual(frame['queue']['coveredMs'], 10)
        self.assertEqual(frame['queue']['unattributedMs'], 5)
        self.assertEqual(frame['nativeWaits'][0]['owners'][0]['ms'], 7)
        self.assertEqual(frame['nativeWaits'][0]['unattributedMs'], 2)

    def test_timelines_keep_clocks_separate_and_cancelled_requests_visible(self):
        report = {'diagnostics':{'events':[
            {'name':'render.start','id':1,'at':100,'data':{'kind':'base'}},
            {'name':'base.cancelRequested','at':102,'data':{'requestIds':[1]}},
            {'name':'render.cancelled','id':1,'at':107},
        ], 'native':{'spans':[
            {'id':1,'operation':'base','requestId':1,'waitAt':0,'acquiredAt':1,'releasedAt':6}]}}}
        front, native = diagnose.timelines(report)
        self.assertEqual(front['traceEvents'][0]['ts'], 100000)
        self.assertEqual(front['traceEvents'][0]['dur'], 7000)
        self.assertEqual(native['traceEvents'][0]['ts'], 0)
        self.assertIn('NOT aligned', native['clock'])
        result = diagnose.summarize(report)
        self.assertEqual(result['cancellations'][0]['completionAfterRequestMs'], 5)
        self.assertEqual(result['cancellations'][0]['outcome'], 'cancelled')

    def test_first_native_frame_is_separate_from_first_estimated_feedback(self):
        samples = []
        for at, source in [(10, 'estimated'), (20, 'native'), (30, 'native')]:
            samples.append({'kind':'edit','at':at,'total':5,'width':1,'height':1,
                            'diagnostic':{'label':'exposure drag','source':source}})
        rows = diagnose.summarize({'samples':samples})['groups']
        self.assertEqual({(r['source'],r['phase'],r['latency']['n']) for r in rows},
                         {('estimated','first',1), ('native','first',1), ('native','sustained',1)})

    def test_discard_after_failed_gpu_draw_has_an_explicit_final_outcome(self):
        report = {'diagnostics':{'events':[
            {'at':0,'name':'frame.created','data':{'frameId':1,'source':'estimated'}},
            {'at':1,'name':'draw.skipped','data':{'frameId':1}},
            {'at':2,'name':'frame.discarded','data':{'frameId':1,'reason':'estimate-worker-cancelled'}},
        ]}}
        lifecycle = diagnose.summarize(report)['frameLifecycle']
        self.assertEqual(lifecycle[0]['outcome'],'frame.discarded')
        self.assertEqual(lifecycle[0]['reason'],'estimate-worker-cancelled')


if __name__ == '__main__':
    unittest.main()
