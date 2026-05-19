// Bundled catalog of well-known Project Gutenberg classics.
//
// Used two ways:
//   1) The topic tabs (Fiction / Adventure / Mystery) render from this list
//      directly. Gutendex's topic-filtered queries are 15-22s slow, which
//      is unusable on glasses; curated lists are instant and reliable.
//   2) Frontend falls back to this list when the Gutendex catalog API is
//      down so Browse and Search always have something to show.
//
// Each entry has the canonical Gutenberg .txt URL hardcoded so book content
// can be fetched directly via our /api/proxy endpoint, with zero dependency
// on Gutendex being up.
window.__BOOK_READER_FALLBACK_CATALOG__ = (function () {
  function txt(id) { return 'https://www.gutenberg.org/cache/epub/' + id + '/pg' + id + '.txt'; }

  var books = [
    // ----- Marquee classics (popular section) -----
    { id: 84,    title: "Frankenstein; or, the modern prometheus", author: "Mary Wollstonecraft Shelley", subjects: ["Fiction", "Gothic", "Science Fiction"] },
    { id: 1342,  title: "Pride and Prejudice", author: "Jane Austen", subjects: ["Fiction", "Romance"] },
    { id: 11,    title: "Alice's Adventures in Wonderland", author: "Lewis Carroll", subjects: ["Fiction", "Children", "Adventure"] },
    { id: 174,   title: "The Picture of Dorian Gray", author: "Oscar Wilde", subjects: ["Fiction", "Gothic"] },
    { id: 345,   title: "Dracula", author: "Bram Stoker", subjects: ["Fiction", "Gothic", "Horror"] },
    { id: 2701,  title: "Moby Dick; or, The Whale", author: "Herman Melville", subjects: ["Fiction", "Adventure"] },
    { id: 100,   title: "The Complete Works of William Shakespeare", author: "William Shakespeare", subjects: ["Drama", "Poetry"] },

    // ----- Mystery -----
    { id: 1661,  title: "The Adventures of Sherlock Holmes", author: "Arthur Conan Doyle", subjects: ["Fiction", "Mystery"] },
    { id: 2852,  title: "The Hound of the Baskervilles", author: "Arthur Conan Doyle", subjects: ["Fiction", "Mystery"] },
    { id: 834,   title: "The Memoirs of Sherlock Holmes", author: "Arthur Conan Doyle", subjects: ["Fiction", "Mystery"] },
    { id: 108,   title: "The Return of Sherlock Holmes", author: "Arthur Conan Doyle", subjects: ["Fiction", "Mystery"] },
    { id: 2097,  title: "The Sign of the Four", author: "Arthur Conan Doyle", subjects: ["Fiction", "Mystery"] },
    { id: 244,   title: "A Study in Scarlet", author: "Arthur Conan Doyle", subjects: ["Fiction", "Mystery"] },
    { id: 863,   title: "The Mysterious Affair at Styles", author: "Agatha Christie", subjects: ["Fiction", "Mystery"] },
    { id: 155,   title: "The Moonstone", author: "Wilkie Collins", subjects: ["Fiction", "Mystery"] },
    { id: 583,   title: "The Woman in White", author: "Wilkie Collins", subjects: ["Fiction", "Mystery", "Gothic"] },
    { id: 932,   title: "The Murders in the Rue Morgue", author: "Edgar Allan Poe", subjects: ["Fiction", "Mystery"] },

    // ----- Adventure -----
    { id: 120,   title: "Treasure Island", author: "Robert Louis Stevenson", subjects: ["Fiction", "Adventure"] },
    { id: 421,   title: "Kidnapped", author: "Robert Louis Stevenson", subjects: ["Fiction", "Adventure"] },
    { id: 43,    title: "The Strange Case of Dr Jekyll and Mr Hyde", author: "Robert Louis Stevenson", subjects: ["Fiction", "Gothic", "Adventure"] },
    { id: 521,   title: "The Life and Adventures of Robinson Crusoe", author: "Daniel Defoe", subjects: ["Fiction", "Adventure"] },
    { id: 164,   title: "Twenty Thousand Leagues Under the Sea", author: "Jules Verne", subjects: ["Fiction", "Adventure", "Science Fiction"] },
    { id: 103,   title: "Around the World in Eighty Days", author: "Jules Verne", subjects: ["Fiction", "Adventure"] },
    { id: 18857, title: "A Journey to the Centre of the Earth", author: "Jules Verne", subjects: ["Fiction", "Adventure", "Science Fiction"] },
    { id: 1268,  title: "The Mysterious Island", author: "Jules Verne", subjects: ["Fiction", "Adventure"] },
    { id: 2166,  title: "King Solomon's Mines", author: "H. Rider Haggard", subjects: ["Fiction", "Adventure"] },
    { id: 139,   title: "The Lost World", author: "Arthur Conan Doyle", subjects: ["Fiction", "Adventure", "Science Fiction"] },
    { id: 78,    title: "Tarzan of the Apes", author: "Edgar Rice Burroughs", subjects: ["Fiction", "Adventure"] },
    { id: 62,    title: "A Princess of Mars", author: "Edgar Rice Burroughs", subjects: ["Fiction", "Adventure", "Science Fiction"] },
    { id: 76,    title: "Adventures of Huckleberry Finn", author: "Mark Twain", subjects: ["Fiction", "Adventure"] },
    { id: 74,    title: "The Adventures of Tom Sawyer", author: "Mark Twain", subjects: ["Fiction", "Adventure"] },
    { id: 1184,  title: "The Count of Monte Cristo", author: "Alexandre Dumas", subjects: ["Fiction", "Adventure"] },
    { id: 1257,  title: "The Three Musketeers", author: "Alexandre Dumas", subjects: ["Fiction", "Adventure"] },
    { id: 215,   title: "The Call of the Wild", author: "Jack London", subjects: ["Fiction", "Adventure"] },
    { id: 996,   title: "Don Quixote", author: "Miguel de Cervantes Saavedra", subjects: ["Fiction", "Adventure"] },
    { id: 829,   title: "Gulliver's Travels", author: "Jonathan Swift", subjects: ["Fiction", "Adventure"] },

    // ----- Romance -----
    { id: 158,   title: "Emma", author: "Jane Austen", subjects: ["Fiction", "Romance"] },
    { id: 161,   title: "Sense and Sensibility", author: "Jane Austen", subjects: ["Fiction", "Romance"] },
    { id: 105,   title: "Persuasion", author: "Jane Austen", subjects: ["Fiction", "Romance"] },
    { id: 141,   title: "Mansfield Park", author: "Jane Austen", subjects: ["Fiction", "Romance"] },
    { id: 121,   title: "Northanger Abbey", author: "Jane Austen", subjects: ["Fiction", "Romance", "Gothic"] },
    { id: 768,   title: "Wuthering Heights", author: "Emily Brontë", subjects: ["Fiction", "Romance", "Gothic"] },
    { id: 1260,  title: "Jane Eyre: An Autobiography", author: "Charlotte Brontë", subjects: ["Fiction", "Romance", "Gothic"] },
    { id: 1399,  title: "Anna Karenina", author: "Leo Tolstoy", subjects: ["Fiction", "Romance"] },

    // ----- Drama / literary -----
    { id: 730,   title: "Oliver Twist", author: "Charles Dickens", subjects: ["Fiction"] },
    { id: 98,    title: "A Tale of Two Cities", author: "Charles Dickens", subjects: ["Fiction", "Historical"] },
    { id: 1400,  title: "Great Expectations", author: "Charles Dickens", subjects: ["Fiction"] },
    { id: 766,   title: "David Copperfield", author: "Charles Dickens", subjects: ["Fiction"] },
    { id: 46,    title: "A Christmas Carol", author: "Charles Dickens", subjects: ["Fiction"] },
    { id: 219,   title: "Heart of Darkness", author: "Joseph Conrad", subjects: ["Fiction"] },
    { id: 2554,  title: "Crime and Punishment", author: "Fyodor Dostoyevsky", subjects: ["Fiction"] },
    { id: 28054, title: "The Brothers Karamazov", author: "Fyodor Dostoyevsky", subjects: ["Fiction"] },
    { id: 2600,  title: "War and Peace", author: "Leo Tolstoy", subjects: ["Fiction", "Historical"] },
    { id: 25344, title: "The Scarlet Letter", author: "Nathaniel Hawthorne", subjects: ["Fiction"] },
    { id: 5200,  title: "Metamorphosis", author: "Franz Kafka", subjects: ["Fiction"] },

    // ----- Children -----
    { id: 16,    title: "Peter Pan", author: "J. M. Barrie", subjects: ["Fiction", "Children"] },
    { id: 113,   title: "The Secret Garden", author: "Frances Hodgson Burnett", subjects: ["Fiction", "Children"] },
    { id: 12,    title: "Through the Looking-Glass", author: "Lewis Carroll", subjects: ["Fiction", "Children"] },

    // ----- Science Fiction -----
    { id: 35,    title: "The Time Machine", author: "H. G. Wells", subjects: ["Fiction", "Science Fiction"] },
    { id: 36,    title: "The War of the Worlds", author: "H. G. Wells", subjects: ["Fiction", "Science Fiction"] },
    { id: 5230,  title: "The Invisible Man", author: "H. G. Wells", subjects: ["Fiction", "Science Fiction"] },
    { id: 159,   title: "The Island of Doctor Moreau", author: "H. G. Wells", subjects: ["Fiction", "Science Fiction"] },
    { id: 1013,  title: "The First Men in the Moon", author: "H. G. Wells", subjects: ["Fiction", "Science Fiction"] },

    // ----- Gothic / horror -----
    { id: 209,   title: "The Turn of the Screw", author: "Henry James", subjects: ["Fiction", "Gothic"] },
    { id: 41,    title: "The Legend of Sleepy Hollow", author: "Washington Irving", subjects: ["Fiction", "Gothic"] },
    { id: 175,   title: "The Phantom of the Opera", author: "Gaston Leroux", subjects: ["Fiction", "Gothic", "Mystery"] },
    { id: 696,   title: "The Castle of Otranto", author: "Horace Walpole", subjects: ["Fiction", "Gothic"] },

    // ----- Non-fiction / philosophy -----
    { id: 1080,  title: "A Modest Proposal", author: "Jonathan Swift", subjects: ["Essay"] },
    { id: 1232,  title: "The Prince", author: "Niccolò Machiavelli", subjects: ["Philosophy"] },
  ];

  books.forEach(function (b) { b.gutenbergTextUrl = txt(b.id); });

  function byTopic(topic) {
    var t = topic.toLowerCase();
    return books.filter(function (b) {
      return b.subjects.some(function (s) { return s.toLowerCase().indexOf(t) >= 0; });
    });
  }

  return {
    books: books,
    byId: books.reduce(function (m, b) { m[b.id] = b; return m; }, {}),
    forTab: function (tab) {
      if (tab === 'popular' || !tab) return books.slice(0, 20);
      if (tab === 'fiction')   return byTopic('Fiction').slice(0, 30);
      if (tab === 'adventure') return byTopic('Adventure');
      if (tab === 'mystery')   return byTopic('Mystery');
      if (tab === 'romance')   return byTopic('Romance');
      if (tab === 'sci-fi')    return byTopic('Science Fiction');
      return books;
    },
    search: function (q) {
      q = (q || '').toLowerCase();
      if (!q) return [];
      return books.filter(function (b) {
        return b.title.toLowerCase().indexOf(q) >= 0 ||
               b.author.toLowerCase().indexOf(q) >= 0;
      });
    },
  };
})();
