"""
Web Push notification sender using VAPID + pywebpush.

Loads subscriptions from a JSON file and sends push messages to all subscribers.
Invalid/expired subscriptions are automatically removed.
"""

import ipaddress
import json
import os
import logging
import tempfile
import threading
from urllib.parse import urlparse
from pathlib import Path

logger = logging.getLogger(__name__)

# Seconds to wait for a push service before giving up on one subscription.
PUSH_TIMEOUT_SEC = 10

# Serializes read-modify-write of the subscriptions file. add/remove run on the
# asyncio thread while notify_all runs in an executor thread; without this a
# subscription added during a notify could be lost when notify_all saves.
_subs_lock = threading.Lock()


def load_subscriptions(path: str) -> list:
    """Load push subscriptions from JSON file. Returns empty list if missing."""
    try:
        if not os.path.exists(path):
            return []
        with open(path, 'r') as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception as e:
        logger.warning(f"Failed to load subscriptions from {path}: {e}")
        return []


def save_subscriptions(path: str, subscriptions: list) -> bool:
    """Save push subscriptions list to JSON file atomically (temp file + rename),
    so a crash or concurrent reader never sees a truncated file."""
    tmp_path = None
    try:
        directory = os.path.dirname(os.path.abspath(path))
        fd, tmp_path = tempfile.mkstemp(
            prefix='.subscriptions-', suffix='.tmp', dir=directory
        )
        with os.fdopen(fd, 'w') as f:
            json.dump(subscriptions, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, path)
        return True
    except Exception as e:
        logger.error(f"Failed to save subscriptions to {path}: {e}")
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
        return False


MAX_SUBSCRIPTIONS = 500
MAX_ENDPOINT_LEN = 2048


def _is_valid_subscription(subscription: dict) -> bool:
    """Subscriptions arrive from anonymous browsers, and we later POST to the
    endpoint — only accept well-formed https push endpoints on public hosts."""
    endpoint = subscription.get('endpoint')
    keys = subscription.get('keys')
    if not isinstance(endpoint, str) or len(endpoint) > MAX_ENDPOINT_LEN:
        return False
    if not isinstance(keys, dict) or not isinstance(keys.get('p256dh'), str) or not isinstance(keys.get('auth'), str):
        return False
    try:
        parsed = urlparse(endpoint)
    except ValueError:
        return False
    if parsed.scheme != 'https' or not parsed.hostname:
        return False
    host = parsed.hostname
    try:
        ip = ipaddress.ip_address(host)
        if not ip.is_global:
            return False
    except ValueError:
        if host == 'localhost' or host.endswith('.localhost') or '.' not in host:
            return False
    return True


def add_subscription(path: str, subscription: dict) -> bool:
    """Add or update a push subscription (keyed by endpoint URL).
    Returns True if it was saved."""
    if not _is_valid_subscription(subscription):
        logger.warning("Rejecting invalid push subscription.")
        return False
    endpoint = subscription['endpoint']
    with _subs_lock:
        subs = load_subscriptions(path)
        # Remove existing subscription with same endpoint (update)
        subs = [s for s in subs if s.get('endpoint') != endpoint]
        if len(subs) >= MAX_SUBSCRIPTIONS:
            logger.warning(f"Subscription limit ({MAX_SUBSCRIPTIONS}) reached, ignoring.")
            return False
        subs.append({'endpoint': endpoint, 'keys': {
            'p256dh': subscription['keys']['p256dh'],
            'auth': subscription['keys']['auth'],
        }})
        if not save_subscriptions(path, subs):
            return False
    logger.info(f"Saved subscription for endpoint: {endpoint[:60]}...")
    return True


def remove_subscription(path: str, endpoint: str):
    """Remove a subscription by endpoint URL."""
    _remove_endpoints(path, {endpoint})


def _remove_endpoints(path: str, endpoints: set) -> int:
    """Remove subscriptions whose endpoint is in `endpoints`. Returns count removed."""
    with _subs_lock:
        subs = load_subscriptions(path)
        kept = [s for s in subs if s.get('endpoint') not in endpoints]
        removed = [s for s in subs if s.get('endpoint') in endpoints]
        if removed:
            save_subscriptions(path, kept)
    for s in removed:
        logger.info(f"Removed subscription: {str(s.get('endpoint'))[:60]}...")
    return len(removed)


# send_push_notification() results
PUSH_OK = 'ok'
PUSH_EXPIRED = 'expired'  # push service says the subscription is gone (404/410)
PUSH_ERROR = 'error'      # anything else (network, timeout, 5xx...): keep it


def send_push_notification(
    subscription: dict,
    title: str,
    body: str,
    icon: str = '/favicon.png',
    vapid_private_key: str = '',
    vapid_claims_sub: str = 'mailto:admin@example.com',
) -> str:
    """
    Send a single Web Push notification.
    Returns PUSH_OK, PUSH_EXPIRED (only for an HTTP 404/410 from the push
    service — safe to delete) or PUSH_ERROR (transient/unknown — keep it).
    """
    endpoint = str(subscription.get('endpoint', ''))[:60]
    try:
        from pywebpush import webpush, WebPushException
    except ImportError as e:
        logger.error(f"Push failed: pywebpush unavailable ({e})")
        return PUSH_ERROR

    data = json.dumps({
        'title': title,
        'body': body,
        'icon': icon,
    })

    try:
        webpush(
            subscription_info=subscription,
            data=data,
            vapid_private_key=vapid_private_key,
            vapid_claims={'sub': vapid_claims_sub},
            timeout=PUSH_TIMEOUT_SEC,
        )
        return PUSH_OK
    except WebPushException as e:
        status = getattr(getattr(e, 'response', None), 'status_code', None)
        # 404 Not Found / 410 Gone = subscription expired or unsubscribed
        if status in (404, 410):
            logger.info(f"Subscription expired ({status}): {endpoint}")
            return PUSH_EXPIRED
        logger.error(f"Push failed (status={status}): {e}")
        return PUSH_ERROR
    except Exception as e:
        # DNS failures, timeouts, connection resets... — not a reason to delete.
        logger.error(f"Push failed: {e}")
        return PUSH_ERROR


def notify_all(
    subscriptions_file: str,
    title: str,
    body: str,
    icon: str = '/favicon.png',
    vapid_private_key: str = '',
    vapid_claims_sub: str = 'mailto:admin@example.com',
) -> int:
    """
    Send push notification to all subscribers.
    Removes expired (404/410) subscriptions automatically.
    Returns number of successful sends.
    """
    if not vapid_private_key:
        logger.warning("VAPID_PRIVATE_KEY not configured — skipping push notifications.")
        return 0

    with _subs_lock:
        subs = load_subscriptions(subscriptions_file)
    if not subs:
        logger.debug("No push subscriptions on file.")
        return 0

    expired = set()
    success_count = 0

    # Network sends happen without the lock held, so a slow push service
    # never blocks add/remove on the asyncio thread.
    for sub in subs:
        result = send_push_notification(
            subscription=sub,
            title=title,
            body=body,
            icon=icon,
            vapid_private_key=vapid_private_key,
            vapid_claims_sub=vapid_claims_sub,
        )
        if result == PUSH_OK:
            success_count += 1
        elif result == PUSH_EXPIRED and sub.get('endpoint'):
            expired.add(sub['endpoint'])

    # Re-read under the lock and drop only the expired endpoints, so
    # subscriptions added while we were sending are kept.
    if expired:
        _remove_endpoints(subscriptions_file, expired)

    logger.info(f"Push sent to {success_count}/{len(subs)} subscribers.")
    return success_count
