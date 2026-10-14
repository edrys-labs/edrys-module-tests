"""A fake Arduino for real-server.spec.ts: lab task-2's sweep on a pty.

    python3 serial-board.py LINK

Makes LINK a symlink to the pty, then sends the sweep once, as task-2 does from setup():
"position:<angle>,distance:<cm>" from 0 to 180 degrees and back. The distance is 120, with an
obstacle at 30 between 60 and 90 degrees, so the last line is "position:0,distance:120.00".
It then stays quiet (the plotter must still show the end of the sweep) and exits after a minute.
"""
import os
import pty
import sys
import time
import tty

link = sys.argv[1]
master, slave = pty.openpty()
tty.setraw(slave)
os.symlink(os.ttyname(slave), link)
try:
    # the plotter opens the port meanwhile; the pty keeps what is sent before that
    time.sleep(1)
    for pos in [*range(0, 181), *range(180, -1, -1)]:
        distance = 30 if 60 <= pos <= 90 else 120
        os.write(master, f"position:{pos},distance:{distance:.2f}\r\n".encode())
        time.sleep(0.005)
    time.sleep(60)
finally:
    os.unlink(link)
