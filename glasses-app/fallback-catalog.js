// Fallback catalog — used when the catalog API (Gutendex) is unreachable.
// Each entry has an exact Project Gutenberg .txt URL so book content can be
// fetched directly without needing the catalog API at all.
//
// IDs and URLs verified against Gutenberg's cache layout
// (https://www.gutenberg.org/cache/epub/{id}/pg{id}.txt is the canonical UTF-8 text).
window.__BOOK_READER_FALLBACK_CATALOG__ = (function () {
  function txt(id) { return 'https://www.gutenberg.org/cache/epub/' + id + '/pg' + id + '.txt'; }

  var books = [
    { id: 84,    title: "Frankenstein; or, the modern prometheus", author: "Mary Wollstonecraft Shelley", subjects: ["Fiction", "Gothic"] },
    { id: 1342,  title: "Pride and Prejudice", author: "Jane Austen", subjects: ["Fiction", "Romance"] },
    { id: 11,    title: "Alice's Adventures in Wonderland", author: "Lewis Carroll", subjects: ["Fiction", "Children"] },
    { id: 174,   title: "The Picture of Dorian Gray", author: "Oscar Wilde", subjects: ["Fiction", "Gothic"] },
    { id: 345,   title: "Dracula", author: "Bram Stoker", subjects: ["Fiction", "Gothic"] },
    { id: 1661,  title: "The Adventures of Sherlock Holmes", author: "Arthur Conan Doyle", subjects: ["Fiction", "Mystery"] },
    { id: 2701,  title: "Moby Dick; or, The Whale", author: "Herman Melville", subjects: ["Fiction", "Adventure"] },
    { id: 76,    title: "Adventures of Huckleberry Finn", author: "Mark Twain", subjects: ["Fiction", "Adventure"] },
    { id: 74,    title: "The Adventures of Tom Sawyer", author: "Mark Twain", subjects: ["Fiction", "Adventure"] },
    { id: 158,   title: "Emma", author: "Jane Austen", subjects: ["Fiction", "Romance"] },
    { id: 161,   title: "Sense and Sensibility", author: "Jane Austen", subjects: ["Fiction", "Romance"] },
    { id: 768,   title: "Wuthering Heights", author: "Emily Brontë", subjects: ["Fiction", "Romance"] },
    { id: 1260,  title: "Jane Eyre: An Autobiography", author: "Charlotte Brontë", subjects: ["Fiction", "Romance"] },
    { id: 730,   title: "Oliver Twist", author: "Charles Dickens", subjects: ["Fiction"] },
    { id: 98,    title: "A Tale of Two Cities", author: "Charles Dickens", subjects: ["Fiction", "Historical"] },
    { id: 1400,  title: "Great Expectations", author: "Charles Dickens", subjects: ["Fiction"] },
    { id: 766,   title: "David Copperfield", author: "Charles Dickens", subjects: ["Fiction"] },
    { id: 46,    title: "A Christmas Carol", author: "Charles Dickens", subjects: ["Fiction"] },
    { id: 1184,  title: "The Count of Monte Cristo", author: "Alexandre Dumas", subjects: ["Fiction", "Adventure"] },
    { id: 1257,  title: "The Three Musketeers", author: "Alexandre Dumas", subjects: ["Fiction", "Adventure"] },
    { id: 219,   title: "Heart of Darkness", author: "Joseph Conrad", subjects: ["Fiction"] },
    { id: 2554,  title: "Crime and Punishment", author: "Fyodor Dostoyevsky", subjects: ["Fiction"] },
    { id: 28054, title: "The Brothers Karamazov", author: "Fyodor Dostoyevsky", subjects: ["Fiction"] },
    { id: 1399,  title: "Anna Karenina", author: "Leo Tolstoy", subjects: ["Fiction", "Romance"] },
    { id: 2600,  title: "War and Peace", author: "Leo Tolstoy", subjects: ["Fiction", "Historical"] },
    { id: 25344, title: "The Scarlet Letter", author: "Nathaniel Hawthorne", subjects: ["Fiction"] },
    { id: 16,    title: "Peter Pan", author: "J. M. Barrie", subjects: ["Fiction", "Children"] },
    { id: 113,   title: "The Secret Garden", author: "Frances Hodgson Burnett", subjects: ["Fiction", "Children"] },
    { id: 35,    title: "The Time Machine", author: "H. G. Wells", subjects: ["Fiction", "Science Fiction"] },
    { id: 36,    title: "The War of the Worlds", author: "H. G. Wells", subjects: ["Fiction", "Science Fiction"] },
    { id: 5230,  title: "The Invisible Man", author: "H. G. Wells", subjects: ["Fiction", "Science Fiction"] },
    { id: 5200,  title: "Metamorphosis", author: "Franz Kafka", subjects: ["Fiction"] },
    { id: 996,   title: "Don Quixote", author: "Miguel de Cervantes Saavedra", subjects: ["Fiction", "Adventure"] },
    { id: 829,   title: "Gulliver's Travels", author: "Jonathan Swift", subjects: ["Fiction", "Adventure"] },
    { id: 209,   title: "The Turn of the Screw", author: "Henry James", subjects: ["Fiction", "Gothic"] },
    { id: 215,   title: "The Call of the Wild", author: "Jack London", subjects: ["Fiction", "Adventure"] },
    { id: 100,   title: "The Complete Works of William Shakespeare", author: "William Shakespeare", subjects: ["Drama", "Poetry"] },
    { id: 1080,  title: "A Modest Proposal", author: "Jonathan Swift", subjects: ["Essay"] },
    { id: 41,    title: "The Legend of Sleepy Hollow", author: "Washington Irving", subjects: ["Fiction", "Gothic"] },
    { id: 1232,  title: "The Prince", author: "Niccolò Machiavelli", subjects: ["Philosophy"] },
  ];

  // Attach the canonical Gutenberg text URL to each entry.
  books.forEach(function (b) { b.gutenbergTextUrl = txt(b.id); });

  function byTopic(topic) {
    return books.filter(function (b) {
      return b.subjects.some(function (s) { return s.toLowerCase().indexOf(topic.toLowerCase()) >= 0; });
    });
  }

  return {
    books: books,
    byId: books.reduce(function (m, b) { m[b.id] = b; return m; }, {}),
    forTab: function (tab) {
      if (tab === 'popular' || !tab) return books.slice(0, 20);
      if (tab === 'fiction')   return byTopic('Fiction').slice(0, 20);
      if (tab === 'adventure') return byTopic('Adventure');
      if (tab === 'mystery')   return byTopic('Mystery');
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
