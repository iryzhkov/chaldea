#!/usr/bin/env python3
"""One Linux CLOCK_REALTIME timer for the nearest durable deadline.
Absolute calendar time includes suspend. CANCEL_ON_SET also wakes the parent
when an administrator changes the clock, so it can re-evaluate and re-arm.
No recurring scan, systemd unit, network, credential, or per-wait process.
"""
import ctypes
import os
import select
import sys

class Timespec(ctypes.Structure):
    _fields_ = [("sec", ctypes.c_long), ("nsec", ctypes.c_long)]
class Itimerspec(ctypes.Structure):
    _fields_ = [("interval", Timespec), ("value", Timespec)]
libc = ctypes.CDLL(None, use_errno=True)
fd = libc.timerfd_create(0, os.O_CLOEXEC)  # CLOCK_REALTIME
if fd < 0:
    raise OSError(ctypes.get_errno(), "timerfd_create")
ms = max(1, int(sys.argv[1]))
spec = Itimerspec(Timespec(0, 0), Timespec(ms // 1000, (ms % 1000) * 1000000))
if libc.timerfd_settime(fd, 1 | 2, ctypes.byref(spec), None) < 0:
    raise OSError(ctypes.get_errno(), "timerfd_settime")
select.select([fd], [], [])
os.close(fd)  # readability includes ECANCELED on a clock change
