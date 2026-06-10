// =====================================================
// Kaon Group - GA4 Dashboard 설정 파일
// =====================================================
// 아래 값들을 실제 값으로 교체한 후 사용하세요.
//
// [설정 방법]
// 1. OAUTH_CLIENT_ID: Google Cloud Console > API 및 서비스 > 사용자 인증 정보
//    > OAuth 2.0 클라이언트 ID 생성 (웹 애플리케이션 유형)
//    > 승인된 자바스크립트 원본에 이 페이지의 URL 추가
//
// 2. propertyId: Google Analytics > 관리 > 속성 > 속성 세부정보
//    (숫자만, 예: 123456789)
// =====================================================

const CONFIG = {
  OAUTH_CLIENT_ID: 'YOUR_OAUTH_CLIENT_ID.apps.googleusercontent.com',

  SITES: [
    {
      id: 'kaon-group',
      name: 'Kaon Group',
      url: 'https://www.kaongroup.com/en/',
      propertyId: 'YOUR_PROPERTY_ID_1',
      color: '#0066CC',
      bgColor: 'rgba(0, 102, 204, 0.08)',
    },
    {
      id: 'kaon-broadband',
      name: 'Kaon Broadband',
      url: 'https://www.kaonbroadband.com/',
      propertyId: 'YOUR_PROPERTY_ID_2',
      color: '#00A86B',
      bgColor: 'rgba(0, 168, 107, 0.08)',
    },
    {
      id: 'kaon-robotics',
      name: 'Kaon Robotics',
      url: 'https://www.kaonrobotics.com/',
      propertyId: 'YOUR_PROPERTY_ID_3',
      color: '#FF6B35',
      bgColor: 'rgba(255, 107, 53, 0.08)',
    },
    {
      id: 'kaon-media',
      name: 'Kaon Media',
      url: 'https://www.kaonmedia.co.kr/',
      propertyId: 'YOUR_PROPERTY_ID_4',
      color: '#7B2FBE',
      bgColor: 'rgba(123, 47, 190, 0.08)',
    },
  ],
};
