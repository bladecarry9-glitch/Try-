# VER TOUR — User Panel

A mobile-first esports player portal built with HTML5, CSS3, vanilla JavaScript, Firebase Authentication, Cloud Firestore, Firebase Cloud Messaging, and Firebase Cloud Functions. This project contains **only the player-facing panel**. It does not include an admin dashboard or admin login screen.

## Project files

```text
VER_TOUR_User_Panel/
├── index.html
├── css/style.css
├── js/app.js
├── js/firebase-config.js
├── firebase-messaging-sw.js
├── firestore.rules
├── firestore.indexes.json
├── firebase.json
├── manifest.webmanifest
├── assets/icon-192.png
└── functions/
    ├── index.js
    └── package.json
```

## 1. Configure Firebase

1. Create a Firebase project.
2. In **Authentication → Sign-in method**, enable **Email/Password**. Google sign-in is intentionally not included.
3. Create a Cloud Firestore database.
4. Add a Firebase Web App in Project settings.
5. Copy the web app settings into `js/firebase-config.js` and `firebase-messaging-sw.js`. Replace every `YOUR_...` placeholder.
6. In Firebase Console → Project settings → Cloud Messaging, create a Web Push certificate and paste its VAPID key into `js/firebase-config.js` as `firebaseVapidKey`.
7. Deploy the Firestore rules and Cloud Functions described below.

Never paste a service-account private key into this web project. The web API key is a Firebase client identifier, not an admin credential. Keep privileged credentials only in trusted server environments.

## 2. Deploy security rules and Cloud Functions

Install the Firebase CLI on your computer, sign in, select the Firebase project, then run these commands from this project folder:

```bash
firebase login
firebase use YOUR_PROJECT_ID
cd functions
npm install
cd ..
firebase deploy --only firestore:rules,firestore:indexes,functions,hosting
```

The callable functions are deployed in `asia-south1`. The web app calls:

- `createPlayerProfile` — creates a player profile, zero-balance wallet, and unique Free Fire UID/nickname registry entries in one trusted transaction.
- `joinTournament` — validates the player, ban status, tournament status, registration slots, duplicate registration, wallet balance, and any required real-money eligibility in one trusted transaction.
- `submitPaymentRequest` — creates a pending bKash/Nagad request after checking the current Firebase-published payment method and verified eligibility. It does not credit the wallet.
- `updatePlayerProfile` — reserves a nickname with server-side validation.
- `awardVerifiedAchievement` — admin-claim-only backend action for points and approved VIP updates after independently verified match results. It writes rank history and never reads or changes wallet balances.

When a trusted administrator changes a deposit transaction from `pending` to `approved`, the `onTransactionStatusChanged` Cloud Function credits the wallet exactly once. Changing a request to `rejected` does not change the wallet. The user client cannot approve payments or change balances.

## 3. Publish data for the player panel

The project has no admin interface. Publish and manage these documents through a separately secured trusted process, such as Firebase Console or an existing private admin backend. Only trusted administrator accounts with the `admin: true` custom claim can write the protected collections under the included rules.

### `publicConfig/paymentMethods`

Example document shape (replace the example number with the current official number; this project contains no hardcoded payment number):

```json
{
  "bkash": {
    "enabled": true,
    "number": "OFFICIAL_BKASH_NUMBER",
    "instructions": "Use the currently published payment instructions. Keep your PIN and OTP private."
  },
  "nagad": {
    "enabled": true,
    "number": "OFFICIAL_NAGAD_NUMBER",
    "instructions": "Use the currently published payment instructions. Keep your PIN and OTP private."
  }
}
```

### `tournaments/{tournamentId}`

Publish only real events. Recommended fields:

```json
{
  "status": "published",
  "isActive": true,
  "registrationOpen": true,
  "name": "Official event name",
  "description": "Event description",
  "rules": "Full tournament rules",
  "rulesShort": "Solo / Squad",
  "bannerUrl": "https://your-approved-image-host/banner.jpg",
  "gameMode": "Squad",
  "mapName": "Bermuda",
  "startAt": "Firestore Timestamp",
  "entryFee": 0,
  "availableSlots": 48,
  "registrationCount": 0,
  "totalSlots": 48
}
```

`availableSlots` is required by the join function and is decremented atomically after a successful registration. Set `entryFee` to `0` for a free event. Do not add betting, cash wagering, random paid rewards, or cash prizes.

### `notices/{noticeId}`

Suggested fields: `status: "published"`, `isActive: true`, `title`, `description`, `imageUrl` (optional), and `publishedAt` (Firestore Timestamp).

### `banners/{bannerId}`

Suggested fields: `status: "published"`, `isActive: true`, `title`, `description`, `imageUrl`, optional `linkUrl` (HTTPS only), `publishedAt`, and optional `expiresAt`.

### Global chat announcements

A trusted administrator may create a `globalChat` document with `isAnnouncement: true`, `nickname: "VER TOUR ADMIN"`, `uid: "system"`, `text`, and `createdAt`. Player-created messages are separately restricted by Firestore rules.

## 4. Real-money eligibility and guardian authorization

Paid wallet requests and paid tournament entry are deliberately blocked unless the trusted backend has verified both of these fields on the user document:

```json
{
  "realMoneyEligible": true,
  "guardianAuthorizationVerified": true
}
```

These fields are **not** accepted from the signup form or writable by the player client. They must only be set by a separate secure eligibility and parent/guardian authorization process. If your project does not have such a process, keep paid features disabled and publish free tournaments only. The app does not support betting, cash wagering, withdrawals, or paid random rewards.

## 5. Firebase Cloud Messaging

Serve the site over HTTPS (Firebase Hosting does this). Configure the VAPID key and the matching Firebase configuration in both the module config and service worker. Users can enable notification permission from their profile. Foreground notifications appear in the app; background notifications use `firebase-messaging-sw.js`.

Some Android WebView-to-APK wrappers do not expose browser push APIs consistently. If push notifications do not work in your chosen wrapper, add a native Android Firebase Messaging bridge in the wrapper app and pass notifications into the WebView. The in-app Firestore notification center remains available independently.

## 6. Run locally

Because this project uses JavaScript modules, do not open `index.html` directly with a `file://` URL. Use Firebase Hosting or a local HTTPS-capable static server. For example, after installing Firebase CLI:

```bash
firebase emulators:start --only hosting,auth,firestore,functions
```

For a quick local static preview, a simple local server can serve the project, but Firebase Auth/FCM production behavior requires the correct authorized domain and HTTPS setup.

## 7. Important implementation notes

- There is no fake tournament data, fake player list, demo wallet balance, or mock transaction history. Empty states are shown until Firebase has published real data.
- Passwords are handled by Firebase Authentication only. They are never stored in Firestore or browser storage.
- Profile pictures are compressed and stored in the device's IndexedDB only. They do not sync between devices and are not included in global chat messages. Firebase Storage is not configured in this version.
- Wallet balance, payment approval, tournament registration, slot deduction, rank, VIP, and ban state are never trusted from browser input.
- The global chat block list is local to this device. Message reports are stored in `chatReports` for trusted moderation.
- Admin replies can be written to a support request's `adminReply` field by a trusted admin backend; the user's support screen listens for updates in real time.
- Add Firebase App Check and review production quotas before public launch. Set up monitoring, backups, and abuse controls appropriate to your deployment.
