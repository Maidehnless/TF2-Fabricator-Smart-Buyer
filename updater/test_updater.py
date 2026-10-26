import importlib.util
import json
import shutil
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

MODULE = Path(__file__).with_name('update_prices.py')
spec = importlib.util.spec_from_file_location('update_prices', MODULE)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
DB = MODULE.parent.parent / 'data' / 'killstreak-prices.json'

class TestUpdater(unittest.TestCase):
    def test_seed_is_complete(self):
        db = mod.read_db(DB)
        self.assertEqual(550, len(db['prices']))
        self.assertEqual(495, db['pricedCount'])
        self.assertEqual(275, len(db['priority']['regular']))
        self.assertEqual(275, len(db['priority']['specialized']))

    def test_aud_currency_validation(self):
        self.assertEqual(Decimal('0.72'), mod.price_aud('A$ 0.72'))
        self.assertEqual(Decimal('1234.56'), mod.price_aud('A$ 1,234.56'))
        with self.assertRaises(ValueError): mod.price_aud('$ 0.72')
        with self.assertRaises(ValueError): mod.price_aud('1,25€')

    def test_incremental_refresh_and_persist(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / 'prices.json'
            shutil.copy(DB, target)
            original = json.loads(target.read_text())
            with patch.object(mod, 'lookup', side_effect=[Decimal('0.68'), None, Decimal('3.11')]), \
                 patch.object(mod.time, 'sleep'), patch.object(mod.random, 'uniform', return_value=0):
                rc = mod.main(['--database', str(target), '--limit', '3', '--leading', '0', '--delay', '3'])
            self.assertEqual(0,rc)
            new = mod.read_db(target)
            self.assertEqual(new['lastRun']['successful'],2)
            self.assertEqual(new['lastRun']['unlisted'],1)
            changed = [x for x in new['prices'] if x['source']=='github-actions-priceoverview']
            self.assertEqual(len(changed),2)
            self.assertEqual(len(new['prices']),550)
            self.assertEqual(len(new['priority']['regular']),275)
            self.assertEqual(len(new['priority']['specialized']),275)
            self.assertNotEqual(new['generatedAtUTC'],original['generatedAtUTC'])

    def test_no_update_on_rate_limit(self):
        with tempfile.TemporaryDirectory() as folder:
            target=Path(folder)/'prices.json'
            shutil.copy(DB,target)
            contents=target.read_bytes()
            with patch.object(mod,'lookup', side_effect=mod.RateLimited('429')):
                mod.main(['--database',str(target),'--limit','1','--leading','0','--delay','3'])
            self.assertEqual(target.read_bytes(),contents)


class TestValidationAndFailures(unittest.TestCase):
    def mutate(self, change):
        with tempfile.TemporaryDirectory() as folder:
            target=Path(folder)/'db.json'
            db=json.loads(DB.read_text())
            change(db)
            target.write_text(json.dumps(db))
            with self.assertRaises(ValueError): mod.read_db(target)

    def test_duplicate_priority_entries_rejected(self):
        self.mutate(lambda db: db['priority']['regular'].append(db['priority']['regular'][0]))

    def test_nonfinite_price_rejected(self):
        self.mutate(lambda db: db['prices'][0].update(price=float('nan')))

    def test_invalid_checked_timestamp_rejected(self):
        self.mutate(lambda db: db['prices'][0].update(checkedAtUTC='not-a-date'))

    def test_failed_attempt_rotates_after_partial_success(self):
        with tempfile.TemporaryDirectory() as folder:
            target=Path(folder)/'db.json';shutil.copy(DB,target)
            selected=mod.choose_rows(mod.read_db(target),2,0)
            with patch.object(mod,'lookup',side_effect=[ValueError('network'),Decimal('0.07')]), patch.object(mod.time,'sleep'):
                mod.main(['--database',str(target),'--limit','2','--leading','0','--delay','3'])
            new=mod.read_db(target)
            row=next(x for x in new['prices'] if x['name']==selected[0]['name'])
            self.assertEqual('error',row['lastResult'])
            self.assertTrue(row['lastAttemptAtUTC'])
            self.assertEqual(selected[0]['checkedAtUTC'],row['checkedAtUTC'])

    def test_rate_limit_after_success_stops_remaining_requests(self):
        with tempfile.TemporaryDirectory() as folder:
            target=Path(folder)/'db.json';shutil.copy(DB,target)
            with patch.object(mod,'lookup',side_effect=[Decimal('0.07'),mod.RateLimited('429')]) as lookup,patch.object(mod.time,'sleep'):
                mod.main(['--database',str(target),'--limit','3','--leading','0','--delay','3'])
            self.assertEqual(2,lookup.call_count)
            self.assertEqual(1,mod.read_db(target)['lastRun']['successful'])

if __name__=='__main__': unittest.main()
