import datetime as dt
import json
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch
from test_updater import mod, fixture_db

NOW=dt.datetime(2026,10,27,12,tzinfo=dt.timezone.utc)
def database(age=0):
    db=fixture_db();db['currency']='USD'
    for row in db['prices']:row['checkedAtUTC']=mod.stamp(NOW-dt.timedelta(hours=age))
    return db

class TestPlanner(unittest.TestCase):
    def plan(self,db,history=None,deferred=None):
        return mod.plan_adaptive(db,history or {},deferred or {},NOW,60,8,60,24,4)

    def test_unchecked_catalog_is_selected_and_reported_as_missing(self):
        db=database()
        for row in db['prices']:row.update(status='unavailable',price=None,checkedAtUTC=None)
        plan=self.plan(db)
        self.assertEqual(60,len(plan['selected']))
        self.assertEqual(0,plan['coverage']['checkedLast24Hours'])
        self.assertEqual(550,plan['coverage']['neverChecked'])

    def test_only_cheapest_eight_per_tier_are_due_after_one_hour(self):
        db=database(2);plan=self.plan(db)
        self.assertEqual(16,len(plan['selected']))
        for tier in ('regular','specialized'):
            self.assertEqual(8,sum(row['tier']==tier for row in plan['selected']))
        self.assertEqual(550,plan['coverage']['checkedLast24Hours'])

    def test_expensive_entries_are_refreshed_before_daily_deadline(self):
        db=database();row=db['prices'][-1];row.update(price=999,checkedAtUTC=mod.stamp(NOW-dt.timedelta(hours=21)))
        plan=self.plan(db)
        self.assertEqual([row['name']],[r['name'] for r in plan['selected']])

    def test_failed_attempt_does_not_make_old_quote_fresh(self):
        db=database();row=db['prices'][-1]
        row.update(price=999,checkedAtUTC=mod.stamp(NOW-dt.timedelta(hours=25)),lastAttemptAtUTC=mod.stamp(NOW),lastResult='verification_error')
        plan=self.plan(db)
        self.assertIn(row['name'],[r['name'] for r in plan['selected']])
        self.assertEqual(1,plan['coverage']['overdue'])

    def test_verified_no_listing_history_counts_as_a_check(self):
        db=database();row=db['prices'][-1];row.update(status='unavailable',price=None,checkedAtUTC=None)
        plan=self.plan(db,{row['name']:{'atUTC':mod.stamp(NOW),'result':'no_active_listings'}})
        self.assertEqual(550,plan['coverage']['checkedLast24Hours'])
        self.assertEqual(0,plan['coverage']['neverChecked'])
        self.assertEqual([],plan['selected'])

    def test_planner_follows_price_changes_and_future_due_times(self):
        db=database(2);row=db['prices'][-1];row['price']=0.01
        self.assertIn(row['name'],[r['name'] for r in self.plan(db)['selected']])
        db=database();plan=self.plan(db)
        self.assertEqual([],plan['selected'])
        self.assertEqual(mod.stamp(NOW+dt.timedelta(hours=1)),plan['nextDueAtUTC'])

    def test_item_failure_can_be_deferred_without_claiming_daily_coverage(self):
        db=database();row=db['prices'][-1];row.update(status='unavailable',price=None,checkedAtUTC=None)
        until=mod.stamp(NOW+dt.timedelta(minutes=30))
        plan=self.plan(db,deferred={row['name']:until})
        self.assertEqual([],plan['selected'])
        self.assertEqual(until,plan['nextDueAtUTC'])
        self.assertEqual(549,plan['coverage']['checkedLast24Hours'])

class TestAdaptiveRuns(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.db=Path(self.tmp.name)/'db.json';self.state=Path(self.tmp.name)/'state.json'
        db=database()
        for row in db['prices']:row.update(status='unavailable',price=None,checkedAtUTC=None)
        db['pricedCount']=0;self.db.write_text(json.dumps(db))
    def run_at(self,minutes,side_effect=None):
        now=mod.stamp(NOW+dt.timedelta(minutes=minutes))
        with patch.object(mod,'utc_now',return_value=now),patch.object(mod,'lookup',side_effect=side_effect,return_value=Decimal('0.50')) as request,patch.object(mod.time,'sleep'),patch.dict(mod.os.environ,{'GITHUB_STEP_SUMMARY':''}):
            mod.main(['--database',str(self.db),'--state-file',str(self.state),'--adaptive','--scheduled','--delay','10'])
        return request
    def saved(self):return json.loads(self.state.read_text())

    def test_warmup_covers_all_550_then_only_refreshes_cheaper_entries(self):
        for minute in range(0,100,10):self.run_at(minute)
        state=self.saved()
        self.assertEqual(550,state['dailyCoverage']['checkedLast24Hours'])
        self.assertEqual(550,len(state['attemptHistory']))
        self.assertEqual(0,state['dailyCoverage']['neverChecked'])
        request=self.run_at(200)
        self.assertLessEqual(request.call_count,16)
        self.assertGreater(request.call_count,0)

    def test_rejection_cooldown_is_not_overridden_by_adaptive_planning(self):
        self.run_at(0,[mod.RateLimited('429')])
        before=self.state.read_bytes();request=self.run_at(30)
        self.assertEqual(0,request.call_count);self.assertEqual(before,self.state.read_bytes())

    def test_bad_item_does_not_stall_the_rest_of_the_catalog(self):
        self.run_at(0,[ValueError('bad item')]+[Decimal('0.50')]*59)
        first_pending=self.saved()['pending'][0]
        request=self.run_at(30)
        names=[c.args[0]['name'] for c in request.call_args_list]
        self.assertNotIn(first_pending,names)
        self.assertGreater(len(names),1)
        self.assertIn(first_pending,self.saved()['deferredEntries'])

    def test_all_unlisted_checks_are_persisted_and_rotate_without_publishing_fake_quotes(self):
        before=self.db.read_bytes();first=self.run_at(0,[None]*60)
        self.assertEqual(before,self.db.read_bytes())
        second=self.run_at(10,[None]*60)
        self.assertFalse({c.args[0]['name'] for c in first.call_args_list}&{c.args[0]['name'] for c in second.call_args_list})
        self.assertEqual(120,self.saved()['dailyCoverage']['checkedLast24Hours'])

    def test_three_bad_entries_cannot_starve_the_catalog(self):
        self.run_at(0,[ValueError('bad item')]*3)
        bad=set(self.saved()['deferredEntries'])
        self.assertEqual(3,len(bad))
        request=self.run_at(30)
        self.assertEqual(60,request.call_count)
        self.assertFalse(bad & {c.args[0]['name'] for c in request.call_args_list})
        self.assertEqual(60,self.saved()['dailyCoverage']['checkedLast24Hours'])

    def test_day_simulation_keeps_catalog_covered_and_cheapest_more_recent(self):
        for minute in range(0,24*60+1,20):self.run_at(minute)
        state=self.saved()
        self.assertEqual(550,state['dailyCoverage']['checkedLast24Hours'])
        self.assertEqual(0,state['dailyCoverage']['overdue'])
        checked=[mod.instant(x['atUTC']) for x in state['attemptHistory'].values()]
        self.assertLess(max(checked)-min(checked),dt.timedelta(hours=24))

    def test_existing_five_hour_idle_deadline_is_replaced_with_adaptive_due_work(self):
        self.run_at(0)
        state=self.saved();state.pop('planningPolicy');state['nextCycleAtUTC']=mod.stamp(NOW+dt.timedelta(hours=5))
        self.state.write_text(json.dumps(state))
        request=self.run_at(10)
        self.assertGreater(request.call_count,0)

    def test_forced_test_finishing_an_adaptive_batch_keeps_adaptive_next_deadline(self):
        # Force a partial batch using a small budget, then finish it through manual test-force.
        now=mod.stamp(NOW)
        with patch.object(mod,'utc_now',return_value=now),patch.object(mod,'lookup',return_value=Decimal('0.50')),patch.object(mod.time,'sleep'):
            mod.main(['--database',str(self.db),'--state-file',str(self.state),'--adaptive','--max-requests','54'])
        with patch.object(mod,'utc_now',return_value=mod.stamp(NOW+dt.timedelta(minutes=1))),patch.object(mod,'lookup',return_value=Decimal('0.50')),patch.object(mod.time,'sleep'):
            mod.main(['--database',str(self.db),'--state-file',str(self.state),'--force-test'])
        state=self.saved()
        self.assertEqual('complete',state['status'])
        self.assertEqual(mod.stamp(NOW+dt.timedelta(minutes=1)),state['nextCycleAtUTC'])

    def test_first_run_with_fresh_quotes_can_wait_without_creating_fake_cycle(self):
        self.db.write_text(json.dumps(database()))
        request=self.run_at(0)
        self.assertEqual(0,request.call_count)
        self.assertFalse(self.state.exists())

    def test_invalid_coverage_counter_is_rejected_before_network(self):
        self.run_at(0)
        state=self.saved();state['dailyCoverage']['checkedLast24Hours']=999
        self.state.write_text(json.dumps(state))
        with self.assertRaises(ValueError):self.run_at(10)

    def test_forced_completion_preserves_all_eight_cheap_candidates_per_tier(self):
        self.run_at(0)
        state=self.saved();db=database()
        due_name=db['priority']['regular'][3]
        row=next(r for r in db['prices'] if r['name']==due_name)
        row['checkedAtUTC']=mod.stamp(NOW-dt.timedelta(hours=2))
        state['attemptHistory'].pop(due_name,None)
        state.update(status='retrying',pending=[db['prices'][-1]['name']],nextCycleAtUTC=None,nextAttemptAtUTC=mod.stamp(NOW))
        state['cycle']={'total':1,'completed':0,'priced':0,'unlisted':0,'startedAtUTC':mod.stamp(NOW)}
        self.db.write_text(json.dumps(db));self.state.write_text(json.dumps(state))
        with patch.object(mod,'utc_now',return_value=mod.stamp(NOW+dt.timedelta(minutes=1))),patch.object(mod,'lookup',return_value=Decimal('0.50')),patch.object(mod.time,'sleep'):
            mod.main(['--database',str(self.db),'--state-file',str(self.state),'--force-test'])
        saved=self.saved()
        self.assertEqual(16,saved['dailyCoverage']['cheapCandidates'])
        self.assertLessEqual(mod.instant(saved['nextCycleAtUTC']),NOW+dt.timedelta(minutes=1))
