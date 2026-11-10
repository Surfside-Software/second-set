# Upgrading from 0.2.2

Version 0.3.0 renamed the app to Second Set. If you used 0.2.2 or earlier:

- Second Set installs as a new app beside the old one and opens its projects from
  the same data folder. Don't run both at once; uninstall the old app when you're
  done with it.
- On macOS and Linux, keys saved by the old app may not unlock. Enter them again in
  Review settings or import them from the File menu; the keys that still unlock keep
  working.
- A review paused in the old app can't resume. Start a new review; finished reviews
  and their reports are unchanged.
- Environment variables now start with `SECOND_SET_`, for example
  `SECOND_SET_MODAL_CONFIG` and `SECOND_SET_SESSION_CREDENTIAL_FILE`. A saved Modal
  configuration needs `appName` `second-set-reviews` and `imageName`
  `second-set-review-engine:latest`, and each provider Secret needs the key
  `SECOND_SET_API_KEY`; see [cloud reviews](cloud-reviews.md).
