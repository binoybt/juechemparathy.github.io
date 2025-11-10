

const firebaseConfig = {
  apiKey: "AIzaSyCQ_kIoe0NrjEmXDY-IWYpPpzLCkGeO3Ck",
  authDomain: "smash-playground.firebaseapp.com",
  projectId: "smash-playground",
  storageBucket: "smash-playground.firebasestorage.app",
  messagingSenderId: "996945866848",
  appId: "1:996945866848:web:fbb8c8a1e55c3a38029305",
  measurementId: "G-784D3NXFMB"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const auth = firebase.auth();

/* OPTIONAL: restrict to your domain in Firebase console:
   Authentication → Settings → Authorized domains → add:
   - localhost
   - yourusername.github.io
*/
