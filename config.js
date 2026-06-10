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
      // Both languages share one property; language split done via URL path filter
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
        { code: 'ko', label: 'Korea',   filterValue: '/ko' },
      ],
    },
    {
      id: 'kaon-broadband',
      name: 'KAON BROADBAND',
      url: 'https://www.kaonbroadband.com/',
      // Each language is a separate GA4 property
      propertyId: null,
      color: '#1E40AF',
      tableColor: '#1E40AF',
      altRowColor: '#EFF6FF',
      topPagesLang: 'en',
      showCountries: true,
      filterField: 'pagePathPlusQueryString',
      languages: [
        { code: 'all', label: '전체' },
        { code: 'en', label: 'English', propertyId: '312829365' },
        { code: 'ko', label: 'Korea',   propertyId: '312802410' },
        { code: 'es', label: 'Spanish', propertyId: '312811083' },
        { code: 'ja', label: 'Japan',   propertyId: '312835831' },
      ],
    },
    {
      id: 'kaon-robotics',
      name: 'KAON ROBOTICS',
      url: 'https://www.kaonrobotics.com/',
      propertyId: null,
      color: '#1E40AF',
      tableColor: '#1E40AF',
      altRowColor: '#EFF6FF',
      topPagesLang: 'ko',
      showCountries: false,
      filterField: 'pagePathPlusQueryString',
      languages: [
        { code: 'all', label: '전체' },
        { code: 'en', label: 'English', propertyId: '312814212' },
        { code: 'ko', label: 'Korea',   propertyId: '312791295' },
      ],
    },
    {
      id: 'kaon-media',
      name: 'KAON MEDIA',
      url: 'https://www.kaonmedia.co.kr/',
      propertyId: null,
      color: '#E87722',
      tableColor: '#E87722',
      altRowColor: '#FFF8F3',
      topPagesLang: 'en',
      showCountries: true,
      filterField: 'pagePathPlusQueryString',
      languages: [
        { code: 'all', label: '전체' },
        { code: 'en', label: 'English',    propertyId: '312799776' },
        { code: 'ko', label: 'Korea',      propertyId: '312807035' },
        { code: 'es', label: 'Spanish',    propertyId: '312798865' },
        { code: 'pt', label: 'Portuguese', propertyId: '312801891' },
        { code: 'ru', label: 'Russian',    propertyId: '312789085' },
      ],
    },
  ],
};
