"""Add the 108 REF2VA preset to a saved instance-config envelope, without network writes.

Weights must already be verified on the server before activating the generated config.
"""
import copy
import json
import sys

WORKFLOW_ID = 'h3-ref2va-nvfp4-community20'
MODEL_NAME = 'H3 REF2VA · 人物多素材参考 · 20步'
MODEL_FILE = 'MiniMax_H3_Ref2VA_pruned_nvfp4.safetensors'
DESCRIPTION = ('REF2VA NVFP4：人物/场景自由参考，不固定首帧；20步，参考图保持比例。'
               '用 <Picture 1>、<Video 1>、<Audio 1> 指定素材用途。'
               '参考视频请用24fps、2–15秒；音频需搭配图片或视频。多素材会增加耗时和显存。')


def build_graph(base):
    graph = json.loads(base) if isinstance(base, str) else copy.deepcopy(base)
    conditions = [n for n in graph.values() if n.get('class_type') == 'MiniMaxH3ImageToVideo']
    unets = [n for n in graph.values() if n.get('class_type') == 'UNETLoader']
    audio_vaes = [key for key, n in graph.items() if n.get('class_type') == 'VAELoader'
                  and 'audio_vae' in n.get('inputs', {}).get('vae_name', '')]
    if len(conditions) != 1 or len(unets) != 1 or len(audio_vaes) != 1:
        raise ValueError('Expected one FL2VA conditioner, diffusion loader and audio VAE')
    # The selected source is a known single-image FL2VA graph. Refuse unrelated media inputs.
    old_loaders = []
    for key, node in graph.items():
        title = node.get('_meta', {}).get('title', '')
        if title.startswith(('ref_image_', 'ref_video_', 'ref_audio_')) or title in ('first_frame', 'last_frame'):
            if title != 'ref_image_01' or node.get('class_type') != 'LoadImage':
                raise ValueError('Unexpected reference in base graph; review manually')
            old_loaders.append(key)
    for key in old_loaders:
        del graph[key]
    condition = conditions[0]
    condition['class_type'] = 'MiniMaxH3ReferenceToVideo'
    condition['_meta'] = {'title': 'MiniMax H3 REF2VA · 自由参考'}
    inputs = condition['inputs']
    inputs.pop('first_frame', None)
    inputs.pop('last_frame', None)
    inputs['audio_vae'] = [audio_vaes[0], 0]
    inputs['ref_image_size'] = 'match'
    unets[0]['inputs']['unet_name'] = MODEL_FILE
    for kind, count in [('image', 9), ('video', 3), ('audio', 3)]:
        for i in range(count):
            title = f'ref_{kind}_{i + 1:02d}'
            key = 'h3_' + title
            if key in graph:
                raise ValueError('Reference node ID collision: ' + key)
            input_name = {'image': 'image', 'video': 'file', 'audio': 'audio'}[kind]
            graph[key] = {'class_type': {'image': 'LoadImage', 'video': 'LoadVideo', 'audio': 'LoadAudio'}[kind],
                          'inputs': {input_name: '__upload_required__.' + {'image': 'png', 'video': 'mp4', 'audio': 'mp3'}[kind]},
                          '_meta': {'title': title}}
            upstream = key
            if kind == 'video':
                upstream = key + '_components'
                if upstream in graph:
                    raise ValueError('Video helper ID collision')
                graph[upstream] = {'class_type': 'GetVideoComponents', 'inputs': {'video': [key, 0]}}
                inputs[f'ref_video_audios.ref_video_audio_{i}'] = [upstream, 1]
            inputs[f'ref_{kind}s.ref_{kind}_{i}'] = [upstream, 0]
    for node in graph.values():
        if node.get('_meta', {}).get('title') == 'output_video':
            node['inputs']['filename_prefix'] = 'H3/REF2VA_Community20'
    return graph


def upgrade(config):
    result = copy.deepcopy(config)
    channels = [ch for ch in result.get('channels', []) if ch.get('id') == 'h3-server']
    if len(channels) != 1:
        raise ValueError('Expected exactly one h3-server channel')
    channel = channels[0]
    existing = [wf for wf in channel.get('workflows', []) if wf.get('id') == WORKFLOW_ID]
    if existing:
        if len(existing) == 1 and existing[0].get('description') == DESCRIPTION:
            if result.get('workflowId') == WORKFLOW_ID:
                del result['workflowId']
                return result, True
            return result, False
        raise ValueError('REF2VA workflow ID already exists; review manually')
    if any(model.get('name') == MODEL_NAME for model in channel.get('models', [])):
        raise ValueError('REF2VA model name collision')
    bases = [wf for wf in channel.get('workflows', []) if wf.get('id') == 'h3-text-nvfp4-community20']
    if len(bases) != 1:
        raise ValueError('Missing unique verified 20-step base workflow')
    graph = build_graph(bases[0]['json'])
    for wf in channel['workflows']:
        if wf.get('category') == 'omniVideo':
            wf['isDefault'] = False
    workflow = {'id': WORKFLOW_ID, 'name': MODEL_NAME, 'category': 'omniVideo', 'json': graph,
                'createdAt': bases[0].get('createdAt', 0), 'isBuiltin': False,
                'isDefault': True, 'description': DESCRIPTION}
    channel['workflows'].insert(0, workflow)
    channel.setdefault('models', []).append({'name': MODEL_NAME, 'capability': 'video',
                                           'comfyuiWorkflow': {'name': MODEL_NAME, 'json': copy.deepcopy(graph)}})
    channel['comfyuiVideoWorkflow'] = {'name': MODEL_NAME, 'json': copy.deepcopy(graph)}
    result.update(videoModel=f'h3-server::{MODEL_NAME}',
                  channelId='h3-server', videoMode='omni', videoSeconds='5')
    if result.get('workflowId') == WORKFLOW_ID:
        del result['workflowId']
    return result, True


if __name__ == '__main__':
    envelope = json.load(sys.stdin)
    envelope['config'], changed = upgrade(envelope['config'])
    print(json.dumps(envelope, ensure_ascii=False))
    print('Updated REF2VA configuration' if changed else 'REF2VA preset already present', file=sys.stderr)
