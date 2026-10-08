// ===========================================================================
//  firebase_config.js  —  PALmonitor 웹 전용 Firebase 설정 ("클라우드 플레이어")
// ===========================================================================
//  프로젝트: fir-2-f3b80 (기존 AI톡/영수증 프로젝트와는 별개)
//
//  로그인(이메일/비밀번호) 사용 설정 필요:
//    Firebase 콘솔 → 빌드 → Authentication → 시작하기
//    → "로그인 방법"에서 "이메일/비밀번호" 사용 설정
//    → "Users" 탭에서 로그인할 계정을 추가
// ===========================================================================

export const firebaseConfig = {
  apiKey: "AIzaSyCXqCgMZV-8bRwy3cqT21mFToAkd2o4kiA",
  authDomain: "fir-2-f3b80.firebaseapp.com",
  databaseURL: "https://fir-2-f3b80-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "fir-2-f3b80",
  storageBucket: "fir-2-f3b80.firebasestorage.app",
  messagingSenderId: "502189480871",
  appId: "1:502189480871:web:50c460e3f434b15e3bf482",
  measurementId: "G-X42LNLRZZZ",
};

// Analytics 사용 여부(측정 ID가 있을 때만). 기본 꺼둠 — 켜려면 true.
export const enableAnalytics = false;
