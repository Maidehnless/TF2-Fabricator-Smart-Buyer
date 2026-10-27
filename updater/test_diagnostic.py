import contextlib
import io
import unittest
import urllib.error
from unittest.mock import patch
import diagnose_price_request as diagnostic

class TestDiagnostic(unittest.TestCase):
    def run_diagnostic(self, opener):
        output=io.StringIO()
        with patch.object(diagnostic.urllib.request,'urlopen',**opener) as opened, patch.object(diagnostic.urllib.request,'getproxies',return_value={'https':'http://secret:password@private-host:8080'}), contextlib.redirect_stdout(output):
            result=diagnostic.main()
        self.assertEqual(1,opened.call_count)
        self.assertNotIn('password',output.getvalue())
        self.assertNotIn('private-host',output.getvalue())
        return result,output.getvalue()

    def test_success_uses_installed_lookup_for_one_request(self):
        class Response:
            status=200
            headers={'Content-Type':'application/json'}
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def read(self,n):return b'{"success":true,"lowest_price":"$0.72"}'
        result,text=self.run_diagnostic({'return_value':Response()})
        self.assertEqual(0,result)
        self.assertIn('Killstreak+SMG',text)
        self.assertIn('verified USD quote $0.72',text)

    def test_429_stops_after_single_request(self):
        error=urllib.error.HTTPError('https://steamcommunity.com/',429,'Too many',{'Retry-After':'3600'},None)
        result,text=self.run_diagnostic({'side_effect':error})
        self.assertEqual(1,result)
        self.assertIn('HTTP status: 429',text)
        self.assertIn('Retry-After: 3600',text)

    def test_network_errors_never_echo_proxy_credentials(self):
        result,text=self.run_diagnostic({'side_effect':urllib.error.URLError('secret:password@private-host')})
        self.assertEqual(1,result)
        self.assertIn('connection or response validation failed',text)
