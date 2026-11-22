"""Order creation entry point."""
from orders.validators import validate
from orders.inventory import Inventory


def create_order(request):
    # Validate the request, reserve stock and optionally persist the order.
    if not validate(request):
        return None
    inv = Inventory()
    inv.reserve(request["items"])
    persist_enabled = request.get("persist", True)
    if persist_enabled:
        save(request)
    return request


def save(request):
    return True
