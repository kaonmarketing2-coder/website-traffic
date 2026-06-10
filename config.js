// =====================================================
// KAON Group - GA4 Dashboard Configuration
// =====================================================

const CONFIG = {
  OAUTH_CLIENT_ID: '1056993809600-1p185717l196vlrar1vo4llpao4t5us0.apps.googleusercontent.com',

  SITES: [
    {
      id: 'kaon-group',
      name: 'KAON GROUP',
      url: 'https://www.kaongroup.com/en/',
      propertyId: '348541450',
      color: '#E87722',
      tableColor: '#E87722',
      altRowColor: '#FFF8F3',
      topPagesLang: 'ko',
      showCountries: false,
      filterField: 'pagePathPlusQueryString',
      languages: [
        { code: 'all', label: '전체', filterValue: null },
        { code: 'en', label: 'English', filterValue: '/en' },
        { code: 'ko', label: 'Korea', filterValue: '/ko' },
      ],
    },
    {
      id: 'kaon-broadband',
      name: 'KAON BROADBAND',
      url: 'https://www.kaonbroadband.com/',
      propertyId: '312829365',
      color: '#1E40AF',
      tableColor: '#1E40AF',
      altRowColor: '#EFF6FF',
      topPagesLang: 'en',
      showCountries: true,
      filterField: 'pagePathPlusQueryString',
      languages: [
        { code: 'all', label: '전체', filterValue: null },
        { code: 'en', label: 'English', filterValue: 'lang=en' },
        { code: 'ko', label: 'Korea', filterValue: 'lang=ko' },
        { code: 'es', label: 'Spanish', filterValue: 'lang=es' },
        { code: 'ja', label: 'Japan', filterValue: 'lang=jp' },
      ],
    },
    {
      id: 'kaon-robotics',
      name: 'KAON ROBOTICS',
      url: 'https://www.kaonrobotics.com/',
      propertyId: '312814212',
      color: '#1E40AF',
      tableColor: '#1E40AF',
      altRowColor: '#EFF6FF',
      topPagesLang: 'ko',
      showCountries: false,
      filterField: 'pagePathPlusQueryString',
      languages: [
        { code: 'all', label: '전체', filterValue: null },
        { code: 'en', label: 'English', filterValue: '/en' },
        { code: 'ko', label: 'Korea', filterValue: '/ko' },
      ],
    },
    {
      id: 'kaon-media',
      name: 'KAON MEDIA',
      url: 'https://www.kaonmedia.co.kr/',
      propertyId: '312799776',
      color: '#E87722',
      tableColor: '#E87722',
      altRowColor: '#FFF8F3',
      topPagesLang: 'en',
      showCountries: true,
      filterField: 'pagePathPlusQueryString',
      languages: [
        { code: 'all', label: '전체', filterValue: null },
        { code: 'en', label: 'English', filterValue: '/eng' },
        { code: 'ko', label: 'Korea', filterValue: '/kor' },
        { code: 'es', label: 'Spanish', filterValue: '/esp' },
        { code: 'pt', label: 'Portuguese', filterValue: '/por' },
        { code: 'ru', label: 'Russian', filterValue: '/rus' },
      ],
    },
  ],
};
