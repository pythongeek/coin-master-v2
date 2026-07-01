import { defineType, defineField } from 'sanity';

export default defineType({
  name: 'rule',
  title: 'Game Rules & Terms',
  type: 'document',
  fields: [
    defineField({
      name: 'title',
      title: 'Rule Module Title',
      type: 'string',
      description: 'নিয়ম বা শর্তাবলীর শিরোনাম (যেমন: "Provably Fair Rules" বা "How to Play")。',
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: 'key',
      title: 'Unique Key / Identifier',
      type: 'string',
      description: 'ফ্রন্টএন্ড কোডে কল করার জন্য ইউনিক কী (যেমন: "how-to-play", "terms-and-conditions")। এটি পরিবর্তন করবেন না।',
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: 'content',
      title: 'Content',
      type: 'array',
      of: [
        {
          type: 'block',
          styles: [
            { title: 'Normal', value: 'normal' },
            { title: 'H2', value: 'h2' },
            { title: 'H3', value: 'h3' },
          ],
        },
      ],
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: 'lastUpdated',
      title: 'Last Updated Date',
      type: 'datetime',
      initialValue: () => new Date().toISOString(),
    }),
  ],
});
