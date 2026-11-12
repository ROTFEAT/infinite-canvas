import unittest
from upgrade_h3_image_inputs import upgrade

class UpgradeTests(unittest.TestCase):
    def test_optional_image_is_connected_and_all_copies_are_updated(self):
        graph={'1':{'class_type':'MiniMaxH3ImageToVideo','inputs':{'prompt':['2',0]}}, '2':{'class_type':'Text','inputs':{'value':'hello'}}}
        frame={**graph,'1':{'class_type':'MiniMaxH3ImageToVideo','inputs':{'first_frame':['3',0]}}}
        c={'channels':[{'id':'h3-server','workflows':[{'category':'omniVideo','json':graph},{'category':'frameVideo','json':frame}], 'models':[{'comfyuiWorkflow':{'json':graph}}], 'comfyuiVideoWorkflow':{'json':graph}}]}
        new,count=upgrade(c)
        self.assertEqual(count,3)
        self.assertNotIn('first_frame',c['channels'][0]['workflows'][0]['json']['1']['inputs'])
        ch=new['channels'][0]
        for g in [ch['workflows'][0]['json'],ch['models'][0]['comfyuiWorkflow']['json'],ch['comfyuiVideoWorkflow']['json']]:
            nid=g['1']['inputs']['first_frame'][0]
            self.assertEqual(g[nid]['_meta']['title'],'ref_image_01')
        self.assertEqual(ch['workflows'][1]['json'],frame)
        again,n=upgrade(new)
        self.assertEqual(n,0)
        self.assertEqual(again,new)

if __name__=='__main__': unittest.main()
