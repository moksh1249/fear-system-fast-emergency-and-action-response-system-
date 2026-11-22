"""External services FEAR depends on, behind small interfaces so the
development stand-ins can be swapped for real ones without touching the APIs.

  - OtpSender: delivers a citizen's login code. DevOutboxOtpSender prints it to
    the server console and stores it in dev_outbox (readable by a super admin
    in FEAR Command) instead of sending an SMS. A real SMS gateway (MSG91,
    Twilio...) implements send() and is selected with FEAR_OTP_PROVIDER.
  - Vehicle registration checks (RTO/VAHAN) are a manual review queue for now:
    a citizen's vehicle starts 'pending' and an RTO operator approves or
    rejects it in FEAR Command. A VAHAN integration would set the status at
    submission time instead.
"""

from __future__ import annotations

import logging
import os

import aiosqlite

from .access import now_iso

logger = logging.getLogger("fear_backend.providers")

OTP_PROVIDER = os.environ.get("FEAR_OTP_PROVIDER", "dev")
DEV_MODE = OTP_PROVIDER == "dev"


class OtpSender:
    async def send(self, conn: aiosqlite.Connection, phone: str, code: str) -> None:
        raise NotImplementedError


class DevOutboxOtpSender(OtpSender):
    async def send(self, conn: aiosqlite.Connection, phone: str, code: str) -> None:
        body = f"Your FEAR login code is {code}. It expires in 5 minutes."
        await conn.execute(
            "INSERT INTO dev_outbox(channel, recipient, body, created_at) VALUES ('sms', ?, ?, ?)",
            (phone, body, now_iso()),
        )
        # Console line on purpose: in dev mode this is how the code reaches the tester.
        print(f"[fear][dev-otp] {phone}: {code}", flush=True)
        logger.info("dev OTP issued for %s", phone)


def otp_sender() -> OtpSender:
    if OTP_PROVIDER == "dev":
        return DevOutboxOtpSender()
    raise RuntimeError(f"FEAR_OTP_PROVIDER={OTP_PROVIDER!r} has no implementation yet")
