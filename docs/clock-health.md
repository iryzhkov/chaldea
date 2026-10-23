# Clock health

The clock adapter emits the existing three-field health JSON every ten seconds.
For timesyncd it requires the typed D-Bus synchronization flag and an accepted
NTP measurement with a conservative accuracy bound of 30 seconds.

An ignored NTP reply does not replace the last accepted measurement. The
clock-health CLI keeps that accepted report beside its output in a
`.timesyncd` file. This is public time evidence, protected by the same
owner, symlink, size and directory checks as other trusted inputs. It contains
no credentials.

Fallback requires timesyncd to remain active and synchronized, a recognized
ignored-packet layout, the same boot, and consistent monotonic and wall-clock
elapsed time. It revalidates the original report using the original NTP
timestamp and poll interval. The age limit remains three polling intervals,
with a 120-second minimum and a one-hour maximum. Reading the cache never
renews that limit. New inaccurate measurements, unsynchronized status, unknown
status and failed queries fail closed and discard the cache.

On first installation, after reboot, or after evidence expires, the adapter
needs an accepted reply before it can report healthy. Persistent rejected
replies can therefore still cause an outage once accepted evidence is stale.
No ignored measurement is used as a new source of clock accuracy.
