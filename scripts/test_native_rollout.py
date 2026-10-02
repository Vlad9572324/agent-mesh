import unittest

import native_activity_validation as check


class NativeActivityValidationTests(unittest.TestCase):
    def test_rfc3339_variable_precision(self):
        for fraction in ('', '.4', '.404', '.4044', '.339286', '.123456789'):
            for zone in ('Z', '+00:00', '-03:30'):
                with self.subTest(fraction=fraction, zone=zone):
                    check.timestamp('2026-10-01T10:51:11' + fraction + zone)

    def test_rejects_invalid_timestamp(self):
        for value in (None, '', '2026-10-01T10:51:11', '2026-02-31T10:51:11Z',
                      '2026-10-01T10:51:11.1234567890Z', '2026-10-01T10:51:11.Z'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                check.timestamp(value)

    def test_four_digit_timestamp_in_fixture_activity_page(self):
        event = dict(id='event-1', seq=55, channel_id='test', actor_id='test', client_id='event-1',
                     session_id='native-test', runtime='codex', event_type='session.ended', tool_name=None,
                     message_id=None, created_at='2026-10-01T10:51:11.4044Z',
                     provenance='client_reported', server_verified=False)
        self.assertEqual(check.validate_page(dict(activity=[event], has_more=False, next_after_seq=55),
                                            'test', 54, 2), {'event-1'})


if __name__ == '__main__':
    unittest.main()
