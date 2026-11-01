// Features page: reveal sections on scroll and run each drawing's animation only while it is
// on screen (saves battery on phones). Nothing runs for visitors who prefer less motion.
(function () {
  'use strict';
  var reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var reveals = document.querySelectorAll('[data-reveal]');
  var arts = document.querySelectorAll('.fx-art');
  if (!('IntersectionObserver' in window) || reduced) {
    reveals.forEach(function (n) { n.classList.add('in'); });
    arts.forEach(function (n) { n.classList.add('run', 'still'); });
    return;
  }
  var io = new IntersectionObserver(function (es) {
    es.forEach(function (e) {
      if (!e.isIntersecting) return;
      e.target.classList.add('in');
      io.unobserve(e.target);
    });
  }, { threshold: 0.12 });
  reveals.forEach(function (n) { io.observe(n); });
  var run = new IntersectionObserver(function (es) {
    es.forEach(function (e) { e.target.classList.toggle('run', e.isIntersecting); });
  }, { rootMargin: '60px' });
  arts.forEach(function (n) { run.observe(n); });
})();
