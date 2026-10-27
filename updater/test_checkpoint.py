import datetime as dt
import json
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch
from test_updater import mod, write_fixture

class TestCheckpoint(unittest.TestCase):
    def setUp(self):
        env=patch.dict(mod.os.environ,{'GITHUB_STEP_SUMMARY':''})
        env.start();self.addCleanup(env.stop)
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db=Path(self.temp.name)/'prices.json'
        self.state=Path(self.temp.name)/'state.json'
        write_fixture(self.db)
        self.base=dt.datetime(2026,10,27,0,0,tzinfo=dt.timezone.utc)

    def run_at(self,minute,results,limit=3,max_requests=60,scheduled=False):
        stamp=(self.base+dt.timedelta(minutes=minute)).isoformat().replace('+00:00','Z')
        args=['--database',str(self.db),'--state-file',str(self.state),'--limit',str(limit),
              '--leading','0','--delay','10','--max-requests',str(max_requests)]
        if scheduled:args.append('--scheduled')
        with patch.object(mod,'utc_now',return_value=stamp),patch.object(mod,'lookup',side_effect=results) as lookup,patch.object(mod.time,'sleep'):
            rc=mod.main(args)
        return rc,lookup

    def saved(self):return json.loads(self.state.read_text())

    def test_first_request_429_preserves_prices_and_records_retry(self):
        before=self.db.read_bytes()
        _,request=self.run_at(0,[mod.RateLimited('429')])
        self.assertEqual(1,request.call_count)
        self.assertEqual(before,self.db.read_bytes())
        state=self.saved()
        self.assertEqual(3,len(state['pending']))
        self.assertEqual('retrying',state['status'])
        self.assertEqual('2026-10-27T00:30:00Z',state['nextAttemptAtUTC'])

    def test_partial_success_resumes_same_pending_item_without_rechecking_completed_name(self):
        _,first=self.run_at(0,[Decimal('0.07'),mod.RateLimited('429')])
        completed_name=first.call_args_list[0].args[0]['name']
        failed_name=first.call_args_list[1].args[0]['name']
        self.assertEqual(failed_name,self.saved()['pending'][0])
        _,retry=self.run_at(30,[Decimal('0.08'),Decimal('0.09')])
        names=[c.args[0]['name'] for c in retry.call_args_list]
        self.assertEqual(failed_name,names[0]);self.assertNotIn(completed_name,names)
        self.assertEqual([],self.saved()['pending']);self.assertEqual('complete',self.saved()['status'])
        self.assertEqual('USD',mod.read_db(self.db)['currency'])

    def test_cooldown_prevents_even_a_manual_run_contacting_steam_early(self):
        self.run_at(0,[mod.RateLimited('429')])
        before=self.state.read_bytes()
        _,request=self.run_at(29,[AssertionError('must not contact Steam')])
        self.assertEqual(0,request.call_count);self.assertEqual(before,self.state.read_bytes())

    def test_repeated_429_keeps_retrying_the_same_work_until_success(self):
        self.run_at(0,[mod.RateLimited('429')])
        initial=self.saved()['pending']
        self.run_at(30,[mod.RateLimited('429')])
        self.assertEqual(initial,self.saved()['pending'])
        self.run_at(60,[Decimal('0.07')]*3)
        self.assertEqual('complete',self.saved()['status'])

    def test_budget_exhaustion_checkpoints_and_resumes_the_entire_selected_list(self):
        self.run_at(0,[Decimal('0.07')]*2,limit=5,max_requests=2)
        self.assertEqual(3,len(self.saved()['pending']))
        self.run_at(30,[Decimal('0.08')]*2,limit=5,max_requests=2)
        self.assertEqual(1,len(self.saved()['pending']))
        self.run_at(60,[Decimal('0.09')],limit=5,max_requests=2)
        self.assertEqual(5,self.saved()['cycle']['completed'])
        self.assertEqual('2026-10-27T06:00:00Z',self.saved()['nextCycleAtUTC'])

    def test_completed_cycle_waits_five_hours_for_the_next_scheduled_cycle(self):
        self.run_at(0,[Decimal('0.07')]*3)
        _,early=self.run_at(299,[AssertionError('not due')],scheduled=True)
        self.assertEqual(0,early.call_count)
        _,due=self.run_at(300,[Decimal('0.08')]*3,scheduled=True)
        self.assertEqual(3,due.call_count)

    def test_generic_item_error_stays_pending_but_other_entries_can_progress(self):
        self.run_at(0,[ValueError('invalid response'),Decimal('0.07'),None])
        state=self.saved();self.assertEqual(1,len(state['pending']))
        self.assertEqual(2,state['cycle']['completed']);self.assertEqual('retrying',state['status'])
        self.run_at(30,[Decimal('0.09')]);self.assertEqual('complete',self.saved()['status'])

    def test_longer_server_retry_after_is_honoured(self):
        self.assertTrue(hasattr(mod.RateLimited('429'),'retry_after'))
        self.run_at(0,[mod.RateLimited('429',retry_after=3600)])
        self.assertEqual('2026-10-27T01:00:00Z',self.saved()['nextAttemptAtUTC'])
        _,request=self.run_at(30,[AssertionError('too soon')]);self.assertEqual(0,request.call_count)

    def test_invalid_checkpoint_is_rejected_before_network_access(self):
        self.run_at(0,[mod.RateLimited('429')])
        state=self.saved();state['pending'][0]='Untrusted replacement item'
        self.state.write_text(json.dumps(state))
        with self.assertRaises(ValueError):self.run_at(30,[AssertionError('invalid state')])

    def test_unlisted_entries_complete_without_inventing_fresh_quotes(self):
        before=self.db.read_bytes()
        self.run_at(0,[None]*3)
        self.assertEqual('complete',self.saved()['status']);self.assertEqual(3,self.saved()['cycle']['unlisted'])
        self.assertEqual(before,self.db.read_bytes())

    def test_existing_active_cycle_is_resumed_even_when_manual_limit_changes(self):
        self.run_at(0,[Decimal('0.07'),mod.RateLimited('429')],limit=3)
        self.run_at(30,[Decimal('0.08')]*2,limit=6)
        self.assertEqual(3,self.saved()['cycle']['total']);self.assertEqual('complete',self.saved()['status'])


    def test_time_budget_yields_before_actions_timeout(self):
        stamp=self.base.isoformat().replace('+00:00','Z')
        args=['--database',str(self.db),'--state-file',str(self.state),'--limit','3','--leading','0',
              '--delay','10','--max-runtime-seconds','1']
        with patch.object(mod,'utc_now',return_value=stamp),patch.object(mod,'lookup',return_value=Decimal('0.07')) as lookup, \
             patch.object(mod.time,'monotonic',side_effect=[0,0,2]):
            mod.main(args)
        self.assertEqual(1,lookup.call_count);self.assertEqual(2,len(self.saved()['pending']))
        self.assertEqual('time_budget',self.saved()['lastRun']['reason'])

    def test_summary_reports_waiting_and_progress_without_claiming_a_price_update(self):
        summary=Path(self.temp.name)/'summary.md'
        with patch.dict(mod.os.environ,{'GITHUB_STEP_SUMMARY':str(summary)}):
            self.run_at(0,[mod.RateLimited('429')])
        text=summary.read_text();self.assertIn('retrying',text);self.assertIn('0/3',text);self.assertIn('00:30:00Z',text)

    def test_retry_after_seconds_and_http_date(self):
        self.assertEqual(3600,mod.retry_after_seconds('3600'))
        future=dt.datetime.now(dt.timezone.utc)+dt.timedelta(hours=2)
        value=mod.retry_after_seconds(future.strftime('%a, %d %b %Y %H:%M:%S GMT'))
        self.assertGreater(value,7190);self.assertLessEqual(value,7200)
        self.assertIsNone(mod.retry_after_seconds('not a deadline'))

    def test_duplicate_pending_names_fail_validation(self):
        self.run_at(0,[mod.RateLimited('429')])
        state=self.saved();state['pending'][1]=state['pending'][0];self.state.write_text(json.dumps(state))
        with self.assertRaises(ValueError):self.run_at(30,[AssertionError('invalid checkpoint')])


    def test_unlisted_completed_names_rotate_out_of_the_next_cycle(self):
        _,first=self.run_at(0,[None]*3)
        _,second=self.run_at(300,[None]*3,scheduled=True)
        first_names={c.args[0]['name'] for c in first.call_args_list}
        second_names={c.args[0]['name'] for c in second.call_args_list}
        self.assertFalse(first_names & second_names)
        self.assertEqual(6,len(self.saved()['attemptHistory']))

    def test_successful_later_batch_keeps_previous_unlisted_attempt_history(self):
        _,first=self.run_at(0,[None,mod.RateLimited('429')])
        name=first.call_args_list[0].args[0]['name']
        self.run_at(30,[Decimal('0.08')]*2)
        self.assertEqual('no_active_listings',self.saved()['attemptHistory'][name]['result'])

if __name__=='__main__':unittest.main()
