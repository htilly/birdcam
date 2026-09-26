"""
Web Push notification sender using VAPID + pywebpush.

Loads subscriptions from a JSON file and sends push messages to all subscribers.
Invalid/expired subscriptions are automatically removed.
"""

import ipaddress
import json
import os
import logging
from urllib.parse import urlparse
from pathlib import Path

logger = logging.getLogger(__name__)


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


def save_subscriptions(path: str, subscriptions: list):
    """Save push subscriptions list to JSON file."""
    try:
        with open(path, 'w') as f:
            json.dump(subscriptions, f, indent=2)
    except Exception as e:
        logger.error(f"Failed to save subscriptions to {path}: {e}")


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


def add_subscription(path: str, subscription: dict):
    """Add or update a push subscription (keyed by endpoint URL)."""
    if not _is_valid_subscription(subscription):
        logger.warning("Rejecting invalid push subscription.")
        return False
    subs = load_subscriptions(path)
    endpoint = subscription['endpoint']
    # Remove existing subscription with same endpoint (update)
    subs = [s for s in subs if s.get('endpoint') != endpoint]
    if len(subs) >= MAX_SUBSCRIPTIONS:
        logger.warning(f"Subscription limit ({MAX_SUBSCRIPTIONS}) reached, ignoring.")
        return False
    subs.append({'endpoint': endpoint, 'keys': {
        'p256dh': subscription['keys']['p256dh'],
        'auth': subscription['keys']['auth'],
    }})
    save_subscriptions(path, subs)
    logger.info(f"Saved subscription for endpoint: {endpoint[:60]}...")
    return True


def remove_subscription(path: str, endpoint: str):
    """Remove a subscription by endpoint URL."""
    subs = load_subscriptions(path)
    before = len(subs)
    subs = [s for s in subs if s.get('endpoint') != endpoint]
    if len(subs) < before:
        save_subscriptions(path, subs)
        logger.info(f"Removed subscription: {endpoint[:60]}...")


def send_push_notification(
    subscription: dict,
    title: str,
    body: str,
    icon: str = '/favicon.png',
    vapid_private_key: str = '',
    vapid_claims_sub: str = 'mailto:admin@example.com',
) -> bool:
    """
    Send a single Web Push notification.
    Returns True on success, False on failure (expired/invalid subscription).
    """
    try:
        from pywebpush import webpush, WebPushException

        data = json.dumps({
            'title': title,
            'body': body,
            'icon': icon,
        })

        webpush(
            subscription_info=subscription,
            data=data,
            vapid_private_key=vapid_private_key,
            vapid_claims={'sub': vapid_claims_sub},
        )
        return True

    except Exception as e:
        err_str = str(e)
        # 410 Gone = subscription expired/unsubscribed
        if '410' in err_str or '404' in err_str:
            logger.info(f"Subscription expired (410/404): {subscription.get('endpoint', '')[:60]}")
            return False
        logger.error(f"Push failed: {e}")
        return False


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
    Removes expired subscriptions automatically.
    Returns number of successful sends.
    """
    if not vapid_private_key:
        logger.warning("VAPID_PRIVATE_KEY not configured — skipping push notifications.")
        return 0

    subs = load_subscriptions(subscriptions_file)
    if not subs:
        logger.debug("No push subscriptions on file.")
        return 0

    valid_subs = []
    success_count = 0

    for sub in subs:
        ok = send_push_notification(
            subscription=sub,
            title=title,
            body=body,
            icon=icon,
            vapid_private_key=vapid_private_key,
            vapid_claims_sub=vapid_claims_sub,
        )
        if ok:
            valid_subs.append(sub)
            success_count += 1
        else:
            # Remove expired/invalid subscription
            logger.info(f"Removing expired subscription: {sub.get('endpoint', '')[:60]}...")

    # Persist cleaned subscription list
    if len(valid_subs) != len(subs):
        save_subscriptions(subscriptions_file, valid_subs)

    logger.info(f"Push sent to {success_count}/{len(subs)} subscribers.")
    return success_count
