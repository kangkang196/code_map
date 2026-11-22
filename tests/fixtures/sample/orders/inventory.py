class Inventory:
    def reserve(self, items):
        total = 0
        for item in items:
            total += item.qty
        return total

    def release(self, items):
        return len(items)
