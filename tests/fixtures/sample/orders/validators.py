"""Validation helpers for orders."""


def check_quota(user):
    # verify the user has remaining quota
    return user.quota > 0


def validate(request):
    """Validate an order request before persisting."""
    if not request.get("items"):
        return False
    return check_quota(request["user"])
