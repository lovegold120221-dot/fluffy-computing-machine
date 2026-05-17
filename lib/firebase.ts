import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';

// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyDjmcE7CiKrNpSnu20gFB2cG620HU36Zqg",
  authDomain: "gen-lang-client-0836251512.firebaseapp.com",
  databaseURL: "https://gen-lang-client-0836251512-default-rtdb.firebaseio.com",
  projectId: "gen-lang-client-0836251512",
  storageBucket: "gen-lang-client-0836251512.firebasestorage.app",
  messagingSenderId: "811711024905",
  appId: "1:811711024905:web:b805531d56342ba41b8dd8",
  measurementId: "G-CEGJCJ914Y"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

export async function testConnection() {
  console.log("Firebase Auth initialized for project:", firebaseConfig.projectId);
}
