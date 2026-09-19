"""
Offline verification of the account store (accounts.py): signup, duplicate
email rejection, login success/failure, and plan updates. Pure sqlite3 +
stdlib hashlib - no network needed, so this is exhaustively testable, unlike
the billing/Polygon integrations elsewhere in this project.

Run: python3 test_accounts_offline.py
"""
import os
import tempfile

from app.accounts import AccountStore, EmailAlreadyRegistered, InvalidCredentials


def main():
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    os.remove(path)  # AccountStore creates it fresh

    store = AccountStore(path)

    user = store.create_user("Todd@Example.com", "correcthorsebattery")
    assert user.email == "todd@example.com", "emails should be lowercased"
    assert user.plan == "free"
    print("PASS: signup creates a free-plan account with a normalized email")

    try:
        store.create_user("todd@example.com", "anotherpassword")
        raise AssertionError("duplicate email should be rejected")
    except EmailAlreadyRegistered:
        print("PASS: duplicate email signup rejected")

    logged_in = store.verify_login("todd@example.com", "correcthorsebattery")
    assert logged_in.id == user.id
    print("PASS: correct password logs in")

    try:
        store.verify_login("todd@example.com", "wrongpassword")
        raise AssertionError("wrong password should be rejected")
    except InvalidCredentials:
        print("PASS: wrong password rejected")

    try:
        store.verify_login("nobody@example.com", "whatever123")
        raise AssertionError("unknown email should be rejected")
    except InvalidCredentials:
        print("PASS: unknown email rejected")

    store.set_plan(user.id, "live")
    refreshed = store.get_user(user.id)
    assert refreshed.plan == "live"
    print("PASS: plan upgrade persists")

    os.remove(path)
    print("\nALL ASSERTIONS PASSED")


if __name__ == "__main__":
    main()
