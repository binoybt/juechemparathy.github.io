const firebaseConfig = {
  apiKey: "AIzaSyDQbVnLH0A6uL-N43ptBVNI4hDB3BE2Rls",
  authDomain: "smash-26679.firebaseapp.com",
  projectId: "smash-26679",
  storageBucket: "smash-26679.firebasestorage.app",
  messagingSenderId: "877402703377",
  appId: "1:877402703377:web:65db65464dbd385f6b53b0",
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const auth = firebase.auth();
