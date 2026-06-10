// =====================================================
// Kaon Group - GA4 Dashboard 설정 파일
// =====================================================
// [설정 방법]
// 1. OAUTH_CLIENT_ID: Google Cloud Console > 사용자 인증 정보
//    > OAuth 2.0 클라이언트 ID 생성 (웹 애플리케이션 유형)
//    > 승인된 자바스크립트 원본에 이 페이지 URL 추가
//
// 2. propertyId: Google Analytics > 관리 > 속성 설정 (숫자만, 예: 123456789)
//
// 3. languages[].filterValue: 각 언어 버전 URL에 포함된 고유 문자열
//    예) kaonbroadband.com은 ?lang=en, ?lang=ko 형태 사용
//        그 외 사이트는 /en/, /ko/ 경로 방식 사용
//    실제 URL 구조에 맞게 filterValue를 수정해 주세요.
// =====================================================

const CONFIG = {
  OAUTH_CLIENT_ID: '919853705858-her60qjibp2lgpepmjcchecf9k909oab.apps.googleusercontent.com',

  SITES: [
    {
      id: 'kaon-group',
      name: 'Kaon Group',
      url: 'https://www.kaongroup.com/en/',
      propertyId: '348541450',
      color: '#0066CC',
      bgColor: 'rgba(0, 102, 204, 0.08)',
      // filterField: 언어를 구분할 GA4 dimension
      //   'pagePathPlusQueryString' = URL 경로+쿼리 기반 (권장)
      //   'language' = 사용자 브라우저 언어 기반 (URL 구조 모를 때 대안)
      filterField: 'pagePathPlusQueryString',
      languages: [
        { code: 'all', label: '전체', filterValue: null },
        { code: 'en', label: '영문', filterValue: '/en' },
        { code: 'ko', label: '국문', filterValue: '/ko' },
      ],
    },
    {
      id: 'kaon-broadband',
      name: 'Kaon Broadband',
      url: 'https://www.kaonbroadband.com/',
      propertyId: '312829365',
      color: '#00A86B',
      bgColor: 'rgba(0, 168, 107, 0.08)',
      filterField: 'pagePathPlusQueryString',
      // kaonbroadband.com은 ?lang=XX 쿼리 파라미터 사용
      languages: [
        { code: 'all', label: '전체', filterValue: null },
        { code: 'en', label: '영문', filterValue: 'lang=en' },
        { code: 'ko', label: '국문', filterValue: 'lang=ko' },
        { code: 'es', label: '스페인어', filterValue: 'lang=sp' },
        { code: 'ja', label: '일본어', filterValue: 'lang=jp' },
      ],
    },
    {
      id: 'kaon-robotics',
      name: 'Kaon Robotics',
      url: 'https://www.kaonrobotics.com/',
      propertyId: '312814212',
      color: '#FF6B35',
      bgColor: 'rgba(255, 107, 53, 0.08)',
      filterField: 'pagePathPlusQueryString',
      languages: [
        { code: 'all', label: '전체', filterValue: null },
        { code: 'en', label: '영문', filterValue: '/en' },
        { code: 'ko', label: '국문', filterValue: '/ko' },
      ],
    },
    {
      id: 'kaon-media',
      name: 'Kaon Media',
      url: 'https://www.kaonmedia.co.kr/',
      propertyId: '312799776',
      color: '#7B2FBE',
      bgColor: 'rgba(123, 47, 190, 0.08)',
      filterField: 'pagePathPlusQueryString',
      languages: [
        { code: 'all', label: '전체', filterValue: null },
        { code: 'en', label: '영문', filterValue: '/en' },
        { code: 'ko', label: '국문', filterValue: '/ko' },
        { code: 'es', label: '스페인어', filterValue: '/es' },
        { code: 'pt', label: '포르투갈어', filterValue: '/pt' },
        { code: 'ru', label: '러시아어', filterValue: '/ru' },
      ],
    },
  ],
};
