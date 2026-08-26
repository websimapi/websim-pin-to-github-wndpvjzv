const downloadLinks = document.querySelectorAll('a[download]');

downloadLinks.forEach((link) => {
  link.addEventListener('click', () => {
    link.classList.add('is-downloading');
    window.setTimeout(() => link.classList.remove('is-downloading'), 900);
  });
});

const observer = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) entry.target.classList.add('is-visible');
  });
}, { threshold: 0.08 });

document.querySelectorAll('.download-card, .step-row, .detail-card, .source-links a').forEach((element) => {
  element.classList.add('reveal');
  observer.observe(element);
});
