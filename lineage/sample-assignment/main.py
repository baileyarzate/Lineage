# Demo assignment: implement second_largest so the tests pass.


def second_largest(nums):
    """Return the second largest distinct value in nums."""
    unique = sorted(set(nums))
    if len(unique) < 2:
        raise ValueError("need at least two distinct values")
    return unique[-2]

def largest(nums):
    return max(nums)


if __name__ == "__main__":
    assert second_largest([3, 1, 4, 1, 5]) == 4
    assert second_largest([10, 10, 9]) == 9
    print("All tests passed")
def smallest(nums): return min(nums)
