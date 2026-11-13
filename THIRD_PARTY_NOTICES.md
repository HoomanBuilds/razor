# Third-party source acknowledgments

Razor adapts selected source components and integration patterns rather than adopting upstream applications wholesale.

- UI primitives in `src/components/ui` and the class-name helper in `src/lib/utils.ts` were adapted from HoomanBuilds/flash-protocol, commit `2bdc4112182c0601b472ac30b790fa0202eca772`. The owner supplied the repository and authorized reuse. Its README states MIT; the supplied snapshot has no separate root license file.

Additional adapted modules retain their applicable license notices alongside the source. Dependency licenses remain applicable to their respective packages.

- XRP address encoding in `src/lib/recipient-destination.ts` adapts the Apache-2.0 ripple-address-codec layout. See its [notice](src/lib/recipient-destination.NOTICE) and [license](src/lib/licenses/XRPL-APACHE-2.0.txt).
