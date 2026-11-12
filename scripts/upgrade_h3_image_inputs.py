"""Upgrade this fork's H3 text workflows with one optional image -> first_frame input.
Run against a saved instance-config envelope. Does not upload or replace live configuration.
"""
import copy
import json
import sys


def upgrade(config):
    result = copy.deepcopy(config)
    changed = 0

    def patch(raw):
        nonlocal changed
        graph = json.loads(raw) if isinstance(raw, str) else copy.deepcopy(raw)
        targets = [n for n in graph.values() if isinstance(n, dict) and n.get('class_type') == 'MiniMaxH3ImageToVideo']
        if len(targets) != 1 or 'first_frame' in targets[0].get('inputs', {}):
            return raw
        if any(n.get('_meta', {}).get('title') == 'ref_image_01' for n in graph.values()):
            raise ValueError('Existing unconnected ref_image_01 needs manual review')
        node_id = 'h3_ref_image_01'
        if node_id in graph:
            raise ValueError('Input node ID collision')
        graph[node_id] = {'class_type': 'LoadImage', 'inputs': {'image': '__upload_required__.png'}, '_meta': {'title': 'ref_image_01'}}
        targets[0]['inputs']['first_frame'] = [node_id, 0]
        changed += 1
        return json.dumps(graph, ensure_ascii=False) if isinstance(raw, str) else graph

    for channel in result.get('channels', []):
        if channel.get('id') != 'h3-server':
            continue
        for workflow in channel.get('workflows', []):
            if workflow.get('category') == 'omniVideo':
                workflow['json'] = patch(workflow['json'])
        for model in channel.get('models', []):
            wf = model.get('comfyuiWorkflow')
            if wf and wf.get('json'):
                wf['json'] = patch(wf['json'])
        wf = channel.get('comfyuiVideoWorkflow')
        if wf and wf.get('json'):
            wf['json'] = patch(wf['json'])
    return result, changed


if __name__ == '__main__':
    envelope = json.load(sys.stdin)
    envelope['config'], count = upgrade(envelope['config'])
    print(json.dumps(envelope, ensure_ascii=False))
    print(f'Updated {count} workflow copies', file=sys.stderr)
