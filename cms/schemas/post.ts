import { defineType, defineField } from 'sanity';

export default defineType({
  name: 'post',
  title: 'Blog Post / Promotion',
  type: 'document',
  fieldsets: [
    {
      name: 'seo',
      title: 'SEO & Search Engine Optimization',
      options: {
        collapsible: true,
        collapsed: false,
      },
    },
  ],
  fields: [
    defineField({
      name: 'title',
      title: 'Title / Headline',
      type: 'string',
      description: 'প্রোমোশন বা ব্লগের আকর্ষণীয় শিরোনাম দিন।',
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: 'slug',
      title: 'Slug (URL path)',
      type: 'slug',
      options: {
        source: 'title',
        maxLength: 96,
      },
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: 'featuredImage',
      title: 'Featured Image',
      type: 'image',
      options: {
        hotspot: true,
      },
    }),
    defineField({
      name: 'categories',
      title: 'Tags / Categories',
      type: 'array',
      of: [{ type: 'reference', to: [{ type: 'category' }] }],
    }),
    defineField({
      name: 'publishedAt',
      title: 'Publish Date',
      type: 'datetime',
      initialValue: () => new Date().toISOString(),
    }),
    defineField({
      name: 'body',
      title: 'Body Content',
      type: 'array',
      of: [
        {
          type: 'block',
          styles: [
            { title: 'Normal', value: 'normal' },
            { title: 'H1', value: 'h1' },
            { title: 'H2', value: 'h2' },
            { title: 'H3', value: 'h3' },
            { title: 'Quote', value: 'blockquote' },
          ],
        },
        {
          type: 'image',
          options: { hotspot: true },
        },
      ],
    }),
    
    // ── SEO elements ──
    defineField({
      name: 'metaTitle',
      title: 'Meta Title',
      type: 'string',
      fieldset: 'seo',
      description: 'গুগল সার্চে দেখানোর জন্য শিরোনাম (সর্বোচ্চ ৬০ অক্ষর)। ফাঁকা রাখলে মূল শিরোনাম ব্যবহার হবে।',
      validation: (Rule) => Rule.max(60).warning('৬০ অক্ষরের বেশি হলে গুগল সার্চের শিরোনাম কেটে যেতে পারে।'),
    }),
    defineField({
      name: 'metaDescription',
      title: 'Meta Description',
      type: 'text',
      fieldset: 'seo',
      rows: 3,
      description: 'গুগল সার্চে দেখানোর জন্য সংক্ষিপ্ত বিবরণ (১৫০-১৬০ অক্ষর)।',
      validation: (Rule) => Rule.max(160).warning('১৬০ অক্ষরের বেশি হলে গুগল বিবরণটি কেটে দিতে পারে।'),
    }),
    defineField({
      name: 'focusKeyphrase',
      title: 'Focus Keyphrase',
      type: 'string',
      fieldset: 'seo',
      description: 'যে কিওয়ার্ডের জন্য পোস্টটি গুগল সার্চে র‍্যাংক করাতে চান।',
    }),
    defineField({
      name: 'ogImage',
      title: 'Social Sharing Image (Open Graph)',
      type: 'image',
      fieldset: 'seo',
      description: 'ফেসবুক/টুইটার/টেলিগ্রামে শেয়ার করলে এই ছবি দেখাবে। ফীচারড ইমেজ আলাদা করতে চাইলে এটি দিন।',
    }),
  ],
});
