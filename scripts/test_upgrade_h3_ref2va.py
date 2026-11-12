import copy
import unittest
from upgrade_h3_ref2va import upgrade, WORKFLOW_ID, MODEL_NAME, MODEL_FILE


class Ref2VAMigrationTests(unittest.TestCase):
    def config(self):
        graph = {
            'unet': {'class_type': 'UNETLoader', 'inputs': {'unet_name': 'old'}},
            'audio': {'class_type': 'VAELoader', 'inputs': {'vae_name': 'minimax_h3_audio_vae_fp32.safetensors'}},
            'condition': {'class_type': 'MiniMaxH3ImageToVideo', 'inputs': {'clip': ['clip', 0], 'vae': ['vae', 0], 'first_frame': ['old_image', 0]}},
            'old_image': {'class_type': 'LoadImage', 'inputs': {'image': 'private.png'}, '_meta': {'title': 'ref_image_01'}},
            'out': {'class_type': 'SaveVideo', 'inputs': {'filename_prefix': 'old'}, '_meta': {'title': 'output_video'}},
        }
        return {'videoModel': 'old', 'custom': 'keep', 'channels': [{'id': 'h3-server', 'workflows': [
            {'id': 'h3-text-nvfp4-community20', 'name': 'old', 'category': 'omniVideo', 'isDefault': True, 'json': graph},
            {'id': 'frame', 'category': 'frameVideo', 'isDefault': True, 'json': {}}],
            'models': [{'name': 'old', 'custom': 'keep'}]}]}

    def test_adds_real_reference_conditioning_and_preserves_existing_entries(self):
        config = self.config()
        before = copy.deepcopy(config)
        result, changed = upgrade(config)
        self.assertTrue(changed)
        self.assertEqual(config, before)
        channel = result['channels'][0]
        self.assertEqual(channel['models'][0], before['channels'][0]['models'][0])
        self.assertEqual(next(w for w in channel['workflows'] if w['id'] == 'frame'), before['channels'][0]['workflows'][1])
        self.assertEqual(next(w for w in channel['workflows'] if w['id'] == 'h3-text-nvfp4-community20')['json'], before['channels'][0]['workflows'][0]['json'])
        wf = next(w for w in channel['workflows'] if w['id'] == WORKFLOW_ID)
        graph = wf['json']
        cond = graph['condition']
        self.assertEqual(cond['class_type'], 'MiniMaxH3ReferenceToVideo')
        self.assertNotIn('first_frame', cond['inputs'])
        self.assertEqual(cond['inputs']['audio_vae'], ['audio', 0])
        self.assertEqual(cond['inputs']['ref_image_size'], 'match')
        self.assertNotIn('old_image', graph)
        self.assertEqual(graph['unet']['inputs']['unet_name'], MODEL_FILE)
        for kind, count in [('image', 9), ('video', 3), ('audio', 3)]:
            for i in range(count):
                title = f'ref_{kind}_{i + 1:02d}'
                loader = next((key for key, node in graph.items() if node.get('_meta', {}).get('title') == title), None)
                self.assertIsNotNone(loader)
                link = cond['inputs'][f'ref_{kind}s.ref_{kind}_{i}']
                if kind == 'video':
                    self.assertEqual(graph[link[0]]['inputs']['video'], [loader, 0])
                    self.assertEqual(cond['inputs'][f'ref_video_audios.ref_video_audio_{i}'], [link[0], 1])
                else:
                    self.assertEqual(link, [loader, 0])
        self.assertEqual(result['videoModel'], f'h3-server::{MODEL_NAME}')
        self.assertEqual(result['workflowId'], WORKFLOW_ID)
        self.assertEqual(result['custom'], 'keep')
        self.assertEqual(sum(w.get('isDefault', False) for w in channel['workflows'] if w['category'] == 'omniVideo'), 1)

    def test_idempotent_and_rejects_missing_base_or_id_collision(self):
        result, _ = upgrade(self.config())
        again, changed = upgrade(result)
        self.assertFalse(changed)
        self.assertEqual(again, result)
        for config in ({'channels': []}, {'channels': [{'id': 'h3-server', 'workflows': [], 'models': []}]}):
            with self.assertRaises(ValueError):
                upgrade(config)
        config = self.config()
        config['channels'][0]['workflows'].append({'id': WORKFLOW_ID, 'json': {}})
        with self.assertRaises(ValueError):
            upgrade(config)


if __name__ == '__main__':
    unittest.main()
