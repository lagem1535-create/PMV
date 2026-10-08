// ===========================================================================
//  firebase_config.js  —  PALmonitor 웹 전용 Firebase 설정 ("클라우드 플레이어")
// ===========================================================================
//  사용자가 만든 Firebase 프로젝트(fir-2-f3b80)의 웹 앱 설정입니다.
//  기존 AI톡/영수증 프로젝트와는 별개의 프로젝트입니다.
//
//  로그인(이메일/비밀번호) 사용 설정이 필요합니다:
//    Firebase 콘솔 → 빌드 → Authentication → 시작하기
//    → "로그인 방법"에서 "이메일/비밀번호"를 사용 설정
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

// (선택) 릴레이 서버의 WebSocket 주소. 비워두면 로그인 화면에서 직접 입력합니다.
//   예) "ws://192.168.0.10:58080"  또는 공인 도메인이면 "wss://example.com/relay"
export const defaultRelayUrl = "";

// Analytics 사용 여부(측정 ID가 있을 때만). 기본 꺼둠 — 켜려면 true.
export const enableAnalytics = false;
